import fs from "node:fs/promises";
import path from "node:path";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import {
  listSkillsInDefaultDir,
  resolveDefaultSkillsRoot,
} from "../repositories/skillStorage.js";
import type { CatalogAppRow, CatalogRepoRow } from "../types/skill.js";

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

let pool: Pool | null = null;
let dbReady = false;

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    return {
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
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
    connectionTimeoutMillis: 5_000,
  };
}

export function isDbConnected(): boolean {
  return dbReady && pool !== null;
}

export function getDbPool(): Pool {
  if (!pool) {
    throw new Error("PostgreSQL pool is not initialized");
  }
  return pool;
}

export async function queryDb<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(text, params);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skills (
  skill_name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT 'Admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_step SMALLINT NOT NULL DEFAULT 1,
  progress SMALLINT NOT NULL DEFAULT 33,
  status TEXT NOT NULL DEFAULT 'draft',
  selected_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_repos JSONB NOT NULL DEFAULT '[]'::jsonb,
  pipeline_runs JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_name TEXT NOT NULL REFERENCES skills(skill_name) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (skill_name, file_path)
);

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

async function syncDiskSkillsToDb(): Promise<void> {
  const metaPath = path.resolve(process.cwd(), "data", "skills-meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        skillName: string;
        description: string;
        creator: string;
        createdAt: string;
        updatedAt: string;
        currentStep: number;
        progress: number;
        status: string;
        selectedApps: string[];
        selectedRepos: string[];
        pipelineRuns: unknown[];
      }
    >;
    for (const item of Object.values(parsed)) {
      await queryDb(
        `INSERT INTO skills (
           skill_name, description, creator, created_at, updated_at,
           current_step, progress, status, selected_apps, selected_repos, pipeline_runs
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
         ON CONFLICT (skill_name) DO NOTHING`,
        [
          item.skillName,
          item.description || "",
          item.creator || "Admin",
          item.createdAt || new Date().toISOString(),
          item.updatedAt || new Date().toISOString(),
          item.currentStep || 1,
          item.progress || 33,
          item.status || "draft",
          JSON.stringify(item.selectedApps || []),
          JSON.stringify(item.selectedRepos || []),
          JSON.stringify(item.pipelineRuns || []),
        ]
      );
    }
  } catch {
    // Ignore when no local JSON exists
  }

  const diskSkills = await listSkillsInDefaultDir("global");
  for (const disk of diskSkills) {
    const skillDir = path.join(resolveDefaultSkillsRoot("global"), disk.skillName);
    const mdContent = await fs.readFile(disk.filePath, "utf-8").catch(() => "");
    const fmMatch = mdContent.match(/^---\s*\n([\s\S]*?)\n---/);
    const descMatch = fmMatch?.[1].match(/^description:\s*["']?(.+?)["']?\s*$/m);
    const desc = descMatch ? descMatch[1].trim() : "自定义 AI Skill";

    await queryDb(
      `INSERT INTO skills (skill_name, description, creator, current_step, progress, status)
       VALUES ($1, $2, 'System', 1, 33, 'draft')
       ON CONFLICT (skill_name) DO NOTHING`,
      [disk.skillName, desc]
    );

    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile()) {
          const content = await fs.readFile(full, "utf-8").catch(() => "");
          await queryDb(
            `INSERT INTO skill_files (skill_name, file_path, content)
             VALUES ($1, $2, $3)
             ON CONFLICT (skill_name, file_path) DO NOTHING`,
            [disk.skillName, rel, content]
          );
        }
      }
    };
    await walk(skillDir, "");
  }
}

/**
 * Connect to PostgreSQL, initialize schema, and seed initial data on startup.
 */
export async function initDatabase(): Promise<boolean> {
  if (dbReady && pool) return true;

  const candidatePool = new Pool(buildPoolConfig());
  try {
    await candidatePool.query("SELECT 1");
    pool = candidatePool;
    dbReady = true;

    await pool.query(SCHEMA_SQL);
    if (process.env.DB_INIT_SEED !== "false") {
      await seedCatalogData();
    }
    await syncDiskSkillsToDb();

    console.log("[DB] PostgreSQL connected, schema initialized & seed data ready.");
    return true;
  } catch (err) {
    await candidatePool.end().catch(() => {});
    pool = null;
    dbReady = false;
    const msg = err instanceof Error ? err.message : String(err);

    if (process.env.PG_ALLOW_FALLBACK === "true") {
      console.warn(
        `[DB] PostgreSQL unavailable (${msg}); running with local JSON fallback.`
      );
      return false;
    }

    throw new Error(
      `PostgreSQL connection/initialization failed: ${msg}. Set DATABASE_URL (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) in .env.`
    );
  }
}
