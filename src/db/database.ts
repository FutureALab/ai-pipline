import { Database as BunSqliteDatabase } from "bun:sqlite";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import {
  buildResourceSummary,
  enrichSkillFileEntry,
  extractDescriptionFromMarkdown,
  listSkillsInDefaultDir,
  parseSkillFrontmatter,
  readSkillDirectoryFiles,
  resolveAllGlobalSkillRoots,
  resolveDefaultSkillsRoot,
  saveSkillFilesToDir,
} from "../repositories/skillStorage.js";
import type {
  CatalogAppRow,
  CatalogRepoRow,
  SkillFileCategory,
  SkillFileEncoding,
  SkillFileEntry,
} from "../types/skill.js";

const execFileAsync = promisify(execFile);

export type DbDriver = "postgres" | "sqlite";

export const INITIAL_APPS: CatalogAppRow[] = [
  { id: "app-gateway", name: "API Gateway", env: "prod" },
  { id: "app-user-center", name: "User Center", env: "prod" },
  { id: "app-order-service", name: "Order Service", env: "staging" },
  { id: "app-payment-core", name: "Payment Core", env: "prod" },
  { id: "app-ci-runner", name: "Jenkins CI Runner", env: "infra" },
  { id: "app-admin-portal", name: "Admin Portal", env: "staging" },
];

export const INITIAL_REPOS: CatalogRepoRow[] = [
  { id: "repo-01", name: "core-api-gateway", url: "https://git.example.com/org/core-api-gateway.git", branch: "main" },
  { id: "repo-02", name: "user-auth-service", url: "https://git.example.com/org/user-auth-service.git", branch: "main" },
  { id: "repo-03", name: "order-engine", url: "https://git.example.com/org/order-engine.git", branch: "main" },
  { id: "repo-04", name: "payment-settlement", url: "https://git.example.com/org/payment-settlement.git", branch: "main" },
  { id: "repo-05", name: "notification-hub", url: "https://git.example.com/org/notification-hub.git", branch: "main" },
  { id: "repo-06", name: "web-admin-console", url: "https://git.example.com/org/web-admin-console.git", branch: "main" },
  { id: "repo-07", name: "mobile-bff-edge", url: "https://git.example.com/org/mobile-bff-edge.git", branch: "main" },
  { id: "repo-08", name: "data-etl-pipeline", url: "https://git.example.com/org/data-etl-pipeline.git", branch: "main" },
  { id: "repo-09", name: "search-indexer", url: "https://git.example.com/org/search-indexer.git", branch: "main" },
  { id: "repo-10", name: "billing-ledger", url: "https://git.example.com/org/billing-ledger.git", branch: "main" },
  { id: "repo-11", name: "inventory-sync", url: "https://git.example.com/org/inventory-sync.git", branch: "main" },
  { id: "repo-12", name: "audit-log-collector", url: "https://git.example.com/org/audit-log-collector.git", branch: "main" },
];

let pgPool: Pool | null = null;
let sqliteDb: BunSqliteDatabase | null = null;
let activeDriver: DbDriver | null = null;

function buildPgConfig() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    return {
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
    };
  }
  return {
    host: process.env.PGHOST?.trim() || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER?.trim() || "postgres",
    password: process.env.PGPASSWORD ?? "postgres",
    database: process.env.PGDATABASE?.trim() || "ai_pipeline",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  };
}

export function isDbConnected(): boolean {
  return activeDriver !== null;
}

export function getDbDriver(): DbDriver | null {
  return activeDriver;
}

/**
 * Execute a parameterized SQL query against the active database (PostgreSQL or SQLite).
 * Converts PostgreSQL `$1, $2` placeholders and `::jsonb` casts automatically for SQLite.
 */
export async function queryDb<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  if (activeDriver === "postgres" && pgPool) {
    const res = await pgPool.query<T>(sql, params);
    return { rows: res.rows };
  }

  if (activeDriver === "sqlite" && sqliteDb) {
    // Convert $1, $2... -> ? (preserving parameter order even if reused)
    const sqliteParams: unknown[] = [];
    const convertedSql = sql
      .replace(/::jsonb/gi, "")
      .replace(/NOW\(\)/gi, "CURRENT_TIMESTAMP")
      .replace(/\$(\d+)/g, (_m, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        const val = params[idx];
        if (typeof val === "boolean") {
          sqliteParams.push(val ? 1 : 0);
        } else {
          sqliteParams.push(val ?? null);
        }
        return "?";
      });

    const trimmed = convertedSql.trim().toUpperCase();
    const stmt = sqliteDb.query(convertedSql);
    if (trimmed.startsWith("SELECT") || trimmed.includes("RETURNING")) {
      const rows = stmt.all(...(sqliteParams as never[])) as T[];
      return { rows };
    }
    stmt.run(...(sqliteParams as never[]));
    return { rows: [] };
  }

  throw new Error("Database is not initialized. Call initDatabase() first.");
}

const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skills (
  skill_name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT 'Admin',
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_step SMALLINT NOT NULL DEFAULT 1,
  progress SMALLINT NOT NULL DEFAULT 33,
  status TEXT NOT NULL DEFAULT 'draft',
  selected_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_repos JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_mcps JSONB NOT NULL DEFAULT '[]'::jsonb,
  pipeline_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
  has_scripts BOOLEAN NOT NULL DEFAULT FALSE,
  resource_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  skill_md TEXT NOT NULL DEFAULT ''
);

ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS selected_mcps JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS has_scripts BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS resource_summary JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS skill_md TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'streamable-http',
  url TEXT NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers (owner);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_name TEXT NOT NULL REFERENCES skills(skill_name) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  is_executable BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_name, file_path)
);

ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'text/plain';
ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS encoding TEXT NOT NULL DEFAULT 'utf-8';
ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_files ADD COLUMN IF NOT EXISTS is_executable BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS catalog_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'prod',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  skill_name TEXT,
  status TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  streamed_content TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  result JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_trace_spans (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0,
  start_time_ms DOUBLE PRECISION NOT NULL,
  end_time_ms DOUBLE PRECISION NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL,
  status JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_trace_spans_trace_id ON ai_trace_spans (trace_id);
CREATE INDEX IF NOT EXISTS idx_ai_trace_spans_created_at ON ai_trace_spans (created_at DESC);
`;

const SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS skills (
  skill_name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT 'Admin',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_step INTEGER NOT NULL DEFAULT 1,
  progress INTEGER NOT NULL DEFAULT 33,
  status TEXT NOT NULL DEFAULT 'draft',
  selected_apps TEXT NOT NULL DEFAULT '[]',
  selected_repos TEXT NOT NULL DEFAULT '[]',
  selected_mcps TEXT NOT NULL DEFAULT '[]',
  pipeline_runs TEXT NOT NULL DEFAULT '[]',
  frontmatter TEXT NOT NULL DEFAULT '{}',
  has_scripts INTEGER NOT NULL DEFAULT 0,
  resource_summary TEXT NOT NULL DEFAULT '{}',
  skill_md TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'streamable-http',
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers (owner);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_name TEXT NOT NULL REFERENCES skills(skill_name) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  encoding TEXT NOT NULL DEFAULT 'utf-8',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  is_executable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (skill_name, file_path)
);

CREATE TABLE IF NOT EXISTS catalog_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'prod',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  skill_name TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  payload TEXT NOT NULL DEFAULT '{}',
  streamed_content TEXT NOT NULL DEFAULT '',
  error_message TEXT,
  result TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_trace_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0,
  start_time_ms REAL NOT NULL,
  end_time_ms REAL NOT NULL,
  duration_ms REAL NOT NULL,
  status TEXT NOT NULL DEFAULT '{}',
  attributes TEXT NOT NULL DEFAULT '{}',
  events TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_trace_spans_trace_id ON ai_trace_spans (trace_id);
`;

async function tryAutoStartLocalPostgres(): Promise<boolean> {
  try {
    // 1. Look for any existing local postgres container (e.g. postgres:15-alpine)
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-a", "--format", "{{.Names}}\t{{.Image}}"],
      { timeout: 5_000 }
    );
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const match = lines.find((line) => {
      const lower = line.toLowerCase();
      return lower.includes("postgres") || lower.includes("15-alpine");
    });

    if (match) {
      const containerName = match.split("\t")[0];
      console.log(`[DB] Attempting to start local PostgreSQL container: ${containerName}`);
      await execFileAsync("docker", ["start", containerName], { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    }

    // 2. Fallback: try docker compose up -d postgres
    console.log("[DB] Attempting `docker compose up -d postgres`...");
    await execFileAsync("docker", ["compose", "up", "-d", "postgres"], {
      timeout: 15_000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  } catch {
    return false;
  }
}

async function seedCatalogData(): Promise<void> {
  for (const app of INITIAL_APPS) {
    await queryDb(
      `INSERT INTO catalog_apps (id, name, env)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [app.id, app.name, app.env]
    );
  }

  for (const repo of INITIAL_REPOS) {
    await queryDb(
      `INSERT INTO catalog_repos (id, name, url, branch)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [repo.id, repo.name, repo.url, repo.branch]
    );
  }
}

function ensureSqliteColumns(
  db: BunSqliteDatabase,
  tableName: string,
  columns: Array<{ name: string; definition: string }>
): void {
  const existingRows = db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  const existingNames = new Set(existingRows.map((r) => r.name));
  for (const col of columns) {
    if (!existingNames.has(col.name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.definition}`);
    }
  }
}

function applySqliteMigrations(db: BunSqliteDatabase): void {
  ensureSqliteColumns(db, "skills", [
    { name: "selected_mcps", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "frontmatter", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "has_scripts", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "resource_summary", definition: "TEXT NOT NULL DEFAULT '{}'" },
    { name: "skill_md", definition: "TEXT NOT NULL DEFAULT ''" },
  ]);
  ensureSqliteColumns(db, "skill_files", [
    { name: "category", definition: "TEXT NOT NULL DEFAULT 'other'" },
    { name: "mime_type", definition: "TEXT NOT NULL DEFAULT 'text/plain'" },
    { name: "encoding", definition: "TEXT NOT NULL DEFAULT 'utf-8'" },
    { name: "size_bytes", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "is_executable", definition: "INTEGER NOT NULL DEFAULT 0" },
  ]);
}

/**
 * Step 1 of startup skill sync:
 * Load built-in skills from `resource/builtin-skills/` into the database
 * (`skills` + `skill_files`), preserving complete directory resources.
 * If `resource/builtin-skills/` is missing or empty, existing DB records are kept intact.
 */
async function ingestBuiltinSkillsToDb(): Promise<Set<string>> {
  const builtinNames = new Set<string>();
  const builtinRoot = path.resolve(process.cwd(), "resource", "builtin-skills");
  const entries = await fs
    .readdir(builtinRoot, { withFileTypes: true })
    .catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const srcDir = path.join(builtinRoot, skillName);
    const files = await readSkillDirectoryFiles(srcDir);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (!skillMd || !skillMd.content) continue;

    builtinNames.add(skillName);

    const frontmatter = parseSkillFrontmatter(skillMd.content);
    const desc = extractDescriptionFromMarkdown(skillMd.content);
    const { summary, hasScripts } = buildResourceSummary(files);

    await queryDb(
      `INSERT INTO skills (
         skill_name, description, creator, is_builtin, current_step, progress, status,
         frontmatter, has_scripts, resource_summary, skill_md
       )
       VALUES ($1, $2, 'Built-in', $3, 3, 100, 'published', $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (skill_name)
       DO UPDATE SET
         description = EXCLUDED.description,
         is_builtin = EXCLUDED.is_builtin,
         frontmatter = EXCLUDED.frontmatter,
         has_scripts = EXCLUDED.has_scripts,
         resource_summary = EXCLUDED.resource_summary,
         skill_md = EXCLUDED.skill_md`,
      [
        skillName,
        desc,
        true,
        JSON.stringify(frontmatter),
        hasScripts,
        JSON.stringify(summary),
        skillMd.content,
      ]
    );

    await queryDb(`DELETE FROM skill_files WHERE skill_name = $1`, [skillName]);
    for (const file of files) {
      await queryDb(
        `INSERT INTO skill_files (
           skill_name, file_path, content, category, mime_type, encoding, size_bytes, is_executable, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (skill_name, file_path)
         DO UPDATE SET
           content = EXCLUDED.content,
           category = EXCLUDED.category,
           mime_type = EXCLUDED.mime_type,
           encoding = EXCLUDED.encoding,
           size_bytes = EXCLUDED.size_bytes,
           is_executable = EXCLUDED.is_executable,
           updated_at = NOW()`,
        [
          skillName,
          file.path,
          file.content,
          file.category,
          file.mimeType,
          file.encoding,
          file.sizeBytes,
          file.isExecutable,
        ]
      );
    }
  }

  return builtinNames;
}

/**
 * Step 2 of startup skill sync:
 * Import any disk-only skills that are not yet in the database.
 * Uses ON CONFLICT DO NOTHING so the database always remains the source of truth.
 */
async function syncDiskSkillsToDb(builtinNames: Set<string>): Promise<void> {
  const diskSkills = await listSkillsInDefaultDir("global");
  for (const disk of diskSkills) {
    if (builtinNames.has(disk.skillName)) continue;

    const existing = await queryDb<{ skill_name: string }>(
      `SELECT skill_name FROM skills WHERE skill_name = $1`,
      [disk.skillName]
    );
    if (existing.rows.length > 0) {
      continue;
    }

    const skillDir = path.join(resolveDefaultSkillsRoot("global"), disk.skillName);
    const files = await readSkillDirectoryFiles(skillDir);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    const mdContent = skillMd?.content ?? "";
    const frontmatter = parseSkillFrontmatter(mdContent);
    const desc = extractDescriptionFromMarkdown(mdContent, "System AI Skill");
    const { summary, hasScripts } = buildResourceSummary(files);

    await queryDb(
      `INSERT INTO skills (
         skill_name, description, creator, is_builtin, current_step, progress, status,
         frontmatter, has_scripts, resource_summary, skill_md
       )
       VALUES ($1, $2, 'System', $3, 1, 33, 'draft', $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (skill_name) DO NOTHING`,
      [
        disk.skillName,
        desc,
        false,
        JSON.stringify(frontmatter),
        hasScripts,
        JSON.stringify(summary),
        mdContent,
      ]
    );

    for (const file of files) {
      await queryDb(
        `INSERT INTO skill_files (
           skill_name, file_path, content, category, mime_type, encoding, size_bytes, is_executable
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (skill_name, file_path) DO NOTHING`,
        [
          disk.skillName,
          file.path,
          file.content,
          file.category,
          file.mimeType,
          file.encoding,
          file.sizeBytes,
          file.isExecutable,
        ]
      );
    }
  }
}

/**
 * Step 3 of startup skill sync:
 * Restore all skills (built-in + user-created) from the database to the agent
 * skill directories (~/.omp/agent/skills and ~/.pi/agent/skills), so skills
 * remain available even if `resource/builtin-skills/` is deleted.
 */
export async function restoreSkillsFromDbToAgentDirs(): Promise<number> {
  const skillRows = await queryDb<{ skill_name: string; skill_md: string }>(
    `SELECT skill_name, skill_md FROM skills ORDER BY skill_name ASC`
  );
  if (skillRows.rows.length === 0) return 0;

  const fileRows = await queryDb<{
    skill_name: string;
    file_path: string;
    content: string;
    category: string;
    mime_type: string;
    encoding: string;
    size_bytes: number;
    is_executable: boolean | number;
  }>(
    `SELECT skill_name, file_path, content, category, mime_type, encoding, size_bytes, is_executable
     FROM skill_files
     ORDER BY skill_name ASC, file_path ASC`
  );

  const filesBySkill = new Map<string, SkillFileEntry[]>();
  for (const row of fileRows.rows) {
    const list = filesBySkill.get(row.skill_name) ?? [];
    list.push({
      path: row.file_path,
      content: row.content,
      category: (row.category as SkillFileCategory) || undefined,
      mimeType: row.mime_type || undefined,
      encoding: (row.encoding as SkillFileEncoding) || "utf-8",
      sizeBytes: row.size_bytes ?? undefined,
      isExecutable: Boolean(row.is_executable),
    });
    filesBySkill.set(row.skill_name, list);
  }

  const targetRoots = resolveAllGlobalSkillRoots();
  let restoredCount = 0;

  for (const skill of skillRows.rows) {
    let files = filesBySkill.get(skill.skill_name) ?? [];
    if (files.length === 0 && skill.skill_md) {
      files = [enrichSkillFileEntry({ path: "SKILL.md", content: skill.skill_md })];
    }
    if (files.length === 0) continue;

    for (const root of targetRoots) {
      await saveSkillFilesToDir(path.join(root, skill.skill_name), files);
    }
    restoredCount += 1;
  }

  console.log(
    `[DB] Restored ${restoredCount} skill(s) from database to agent directories: ${targetRoots.join(", ")}`
  );
  return restoredCount;
}

async function connectPostgres(): Promise<Pool | null> {
  const candidate = new Pool(buildPgConfig());
  try {
    await candidate.query("SELECT 1");
    return candidate;
  } catch {
    await candidate.end().catch(() => {});
    return null;
  }
}

/**
 * Initialize database (PostgreSQL primary with auto-start; SQLite fallback).
 * No JSON metadata files are used.
 */
export async function initDatabase(): Promise<DbDriver> {
  if (activeDriver) return activeDriver;

  // 1. Try PostgreSQL directly
  let connectedPool = await connectPostgres();

  // 2. If PostgreSQL is unreachable, try auto-starting local container (e.g. 15-alpine)
  if (!connectedPool) {
    const started = await tryAutoStartLocalPostgres();
    if (started) {
      connectedPool = await connectPostgres();
    }
  }

  if (connectedPool) {
    pgPool = connectedPool;
    activeDriver = "postgres";
    await pgPool.query(PG_SCHEMA_SQL);
    console.log("[DB] PostgreSQL connected and schema initialized.");
  } else {
    // 3. Fallback to SQLite (bun:sqlite)
    const sqlitePath = path.resolve(
      process.cwd(),
      process.env.SQLITE_PATH?.trim() || "data/ai-pipeline.sqlite"
    );
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    sqliteDb = new BunSqliteDatabase(sqlitePath);
    sqliteDb.exec(SQLITE_SCHEMA_SQL);
    applySqliteMigrations(sqliteDb);
    activeDriver = "sqlite";
    console.warn(
      `[DB] PostgreSQL unavailable; initialized SQLite database at ${sqlitePath}`
    );
  }

  if (process.env.DB_INIT_SEED !== "false") {
    await seedCatalogData();
  }
  const builtinNames = await ingestBuiltinSkillsToDb();
  await syncDiskSkillsToDb(builtinNames);
  await restoreSkillsFromDbToAgentDirs();

  return activeDriver;
}
