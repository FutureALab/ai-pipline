import { Database as BunSqliteDatabase } from "bun:sqlite";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Pool as GaussPool } from "gaussdb-nodejs";
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { createPool as createMysqlPool, type Pool as MysqlPool } from "mysql2";
import { Pool as PgPool } from "pg";
import {
  decryptConnectionUrl,
  decryptIfEncrypted,
} from "../config/crypto.js";
import { createLogger } from "../config/logger.js";
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
import { BunSqliteDialect } from "./bunSqliteDialect.js";
import type { DatabaseSchema } from "./schema.js";

const dbLog = createLogger("db");
const execFileAsync = promisify(execFile);

export type DbDriver = "postgres" | "mysql" | "gauss" | "sqlite";

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

let kyselyDb: Kysely<DatabaseSchema> | null = null;
let pgPool: PgPool | null = null;
let gaussPool: GaussPool | null = null;
let mysqlPool: MysqlPool | null = null;
let sqliteDb: BunSqliteDatabase | null = null;
let activeDriver: DbDriver | null = null;

export function isDbConnected(): boolean {
  return activeDriver !== null && kyselyDb !== null;
}

export function getDbDriver(): DbDriver | null {
  return activeDriver;
}

export function isMysqlDriver(): boolean {
  return activeDriver === "mysql";
}

/**
 * Returns the active Kysely query builder instance (supports PostgreSQL, MySQL, GaussDB, SQLite).
 */
export function getDb(): Kysely<DatabaseSchema> {
  if (!kyselyDb) {
    throw new Error("Database is not initialized. Call initDatabase() first.");
  }
  return kyselyDb;
}

/**
 * Cross-dialect boolean normalizer (SQLite/MySQL use 0/1; PG/GaussDB use boolean).
 */
export function toDbBool(val: boolean): boolean | number {
  return activeDriver === "sqlite" || activeDriver === "mysql"
    ? val
      ? 1
      : 0
    : val;
}

/**
 * Cross-dialect current timestamp value for inserts/updates.
 */
export function dbNow(): Date | string {
  return activeDriver === "sqlite" ? new Date().toISOString() : new Date();
}

/**
 * Convert an ISO date string or Date into a driver-safe timestamp parameter.
 */
export function toDbTimestamp(val: Date | string): Date | string {
  if (activeDriver === "sqlite") {
    return val instanceof Date ? val.toISOString() : val;
  }
  return val instanceof Date ? val : new Date(val);
}

/**
 * Legacy raw parameterized SQL helper kept for compatibility.
 * Prefer `getDb()` (Kysely) for all new queries.
 */
export async function queryDb<T extends Record<string, unknown> = Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  if (activeDriver === "postgres" && pgPool) {
    const res = await pgPool.query<T>(sqlText, params);
    return { rows: res.rows };
  }

  if (activeDriver === "gauss" && gaussPool) {
    const res = await gaussPool.query<T>(sqlText, params);
    return { rows: res.rows };
  }

  if (activeDriver === "mysql" && mysqlPool) {
    const mysqlParams: unknown[] = [];
    const convertedSql = sqlText
      .replace(/::jsonb/gi, "")
      .replace(/\$(\d+)/g, (_m, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        const val = params[idx];
        mysqlParams.push(typeof val === "boolean" ? (val ? 1 : 0) : (val ?? null));
        return "?";
      });
    const [rows] = await mysqlPool.promise().query(convertedSql, mysqlParams);
    return { rows: Array.isArray(rows) ? (rows as T[]) : [] };
  }

  if (activeDriver === "sqlite" && sqliteDb) {
    const sqliteParams: unknown[] = [];
    const convertedSql = sqlText
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

// ============================================================================
// Driver configuration builders
// ============================================================================

function buildPgConfig() {
  const connectionString = decryptConnectionUrl(process.env.DATABASE_URL);
  if (connectionString && /^postgres(ql)?:\/\//i.test(connectionString)) {
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
    password: decryptIfEncrypted(process.env.PGPASSWORD) || "postgres",
    database: process.env.PGDATABASE?.trim() || "ai_pipeline",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  };
}

function buildGaussConfig() {
  const decryptedDbUrl = decryptConnectionUrl(process.env.DATABASE_URL);
  const rawUrl =
    decryptConnectionUrl(process.env.GAUSS_URL) ||
    (decryptedDbUrl && /^(gaussdb|opengauss):\/\//i.test(decryptedDbUrl)
      ? decryptedDbUrl
      : undefined);

  if (rawUrl) {
    const normalizedUrl = rawUrl.replace(/^(gaussdb|opengauss):\/\//i, "postgresql://");
    return {
      connectionString: normalizedUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      sha256Iterations: "server" as const,
    };
  }

  return {
    host: process.env.GAUSSHOST?.trim() || "127.0.0.1",
    port: Number(process.env.GAUSSPORT || 8000),
    user: process.env.GAUSSUSER?.trim() || "gaussdb",
    password: decryptIfEncrypted(process.env.GAUSSPASSWORD),
    database: process.env.GAUSSDATABASE?.trim() || "ai_pipeline",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    sha256Iterations: "server" as const,
  };
}

function buildMysqlConfig() {
  const decryptedDbUrl = decryptConnectionUrl(process.env.DATABASE_URL);
  const rawUrl =
    decryptConnectionUrl(process.env.MYSQL_URL) ||
    (decryptedDbUrl && /^mysql2?:\/\//i.test(decryptedDbUrl)
      ? decryptedDbUrl
      : undefined);

  if (rawUrl) {
    const parsed = new URL(rawUrl.replace(/^mysql2:\/\//i, "mysql://"));
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username || "root"),
      password: decryptIfEncrypted(decodeURIComponent(parsed.password || "")),
      database: parsed.pathname.replace(/^\//, "") || "ai_pipeline",
      connectionLimit: 10,
      connectTimeout: 5_000,
      charset: "utf8mb4",
    };
  }

  return {
    host: process.env.MYSQL_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER?.trim() || "root",
    password: decryptIfEncrypted(process.env.MYSQL_PASSWORD) || "root",
    database: process.env.MYSQL_DATABASE?.trim() || "ai_pipeline",
    connectionLimit: 10,
    connectTimeout: 5_000,
    charset: "utf8mb4",
  };
}

// ============================================================================
// Multi-dialect DDL schemas
// ============================================================================

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

const GAUSS_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS skills (
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
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers (owner)`,
  `CREATE TABLE IF NOT EXISTS skill_files (
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
  )`,
  `CREATE TABLE IF NOT EXISTS catalog_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    env TEXT NOT NULL DEFAULT 'prod',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS catalog_repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (
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
  )`,
  `CREATE TABLE IF NOT EXISTS ai_trace_spans (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_trace_spans_trace_id ON ai_trace_spans (trace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_trace_spans_created_at ON ai_trace_spans (created_at DESC)`,
];

const MYSQL_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS skills (
    skill_name VARCHAR(255) PRIMARY KEY,
    description TEXT NOT NULL,
    creator VARCHAR(255) NOT NULL DEFAULT 'Admin',
    is_builtin TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    current_step TINYINT NOT NULL DEFAULT 1,
    progress SMALLINT NOT NULL DEFAULT 33,
    status VARCHAR(64) NOT NULL DEFAULT 'draft',
    selected_apps JSON NOT NULL,
    selected_repos JSON NOT NULL,
    selected_mcps JSON NOT NULL,
    pipeline_runs JSON NOT NULL,
    frontmatter JSON NOT NULL,
    has_scripts TINYINT(1) NOT NULL DEFAULT 0,
    resource_summary JSON NOT NULL,
    skill_md LONGTEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id VARCHAR(64) PRIMARY KEY,
    owner VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    transport VARCHAR(64) NOT NULL DEFAULT 'streamable-http',
    url TEXT NOT NULL,
    headers JSON NOT NULL,
    description TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_mcp_servers_owner_name (owner, name),
    KEY idx_mcp_servers_owner (owner)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS skill_files (
    skill_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    content LONGTEXT NOT NULL,
    category VARCHAR(64) NOT NULL DEFAULT 'other',
    mime_type VARCHAR(128) NOT NULL DEFAULT 'text/plain',
    encoding VARCHAR(32) NOT NULL DEFAULT 'utf-8',
    size_bytes INT NOT NULL DEFAULT 0,
    is_executable TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (skill_name, file_path),
    CONSTRAINT fk_skill_files_skill_name
      FOREIGN KEY (skill_name) REFERENCES skills(skill_name) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_apps (
    id VARCHAR(128) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    env VARCHAR(64) NOT NULL DEFAULT 'prod',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS catalog_repos (
    id VARCHAR(128) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    branch VARCHAR(128) NOT NULL DEFAULT 'main',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (
    job_id VARCHAR(64) PRIMARY KEY,
    skill_name VARCHAR(255),
    status VARCHAR(64) NOT NULL,
    started_at BIGINT NOT NULL,
    ended_at BIGINT,
    elapsed_ms INT NOT NULL DEFAULT 0,
    timeout_ms INT NOT NULL DEFAULT 120000,
    payload JSON NOT NULL,
    streamed_content LONGTEXT NOT NULL,
    error_message TEXT,
    result JSON,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ai_trace_spans (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_id VARCHAR(64) NOT NULL,
    span_id VARCHAR(64) NOT NULL,
    parent_span_id VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    kind INT NOT NULL DEFAULT 0,
    start_time_ms DOUBLE NOT NULL,
    end_time_ms DOUBLE NOT NULL,
    duration_ms DOUBLE NOT NULL,
    status JSON NOT NULL,
    attributes JSON NOT NULL,
    events JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_ai_trace_spans_trace_id (trace_id),
    KEY idx_ai_trace_spans_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

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

// ============================================================================
// Connection helpers & startup sync (via Kysely)
// ============================================================================

async function tryAutoStartLocalPostgres(): Promise<boolean> {
  try {
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
      dbLog.info({ containerName }, "Attempting to start local PostgreSQL container");
      await execFileAsync("docker", ["start", containerName], { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    }

    dbLog.info("Attempting `docker compose up -d postgres`...");
    await execFileAsync("docker", ["compose", "up", "-d", "postgres"], {
      timeout: 15_000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  } catch {
    return false;
  }
}

async function connectPostgres(): Promise<PgPool | null> {
  const candidate = new PgPool(buildPgConfig());
  try {
    await candidate.query("SELECT 1");
    return candidate;
  } catch {
    await candidate.end().catch(() => {});
    return null;
  }
}

async function connectGauss(): Promise<GaussPool | null> {
  const candidate = new GaussPool(buildGaussConfig());
  try {
    await candidate.query("SELECT 1");
    return candidate;
  } catch (err) {
    dbLog.warn({ err }, "GaussDB connection attempt failed");
    await candidate.end().catch(() => {});
    return null;
  }
}

async function connectMysql(): Promise<MysqlPool | null> {
  const candidate = createMysqlPool(buildMysqlConfig());
  try {
    await candidate.promise().query("SELECT 1");
    return candidate;
  } catch (err) {
    dbLog.warn({ err }, "MySQL connection attempt failed");
    await candidate.promise().end().catch(() => {});
    return null;
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

async function initSqliteFallback(): Promise<void> {
  const sqlitePath = path.resolve(
    process.cwd(),
    process.env.SQLITE_PATH?.trim() || "data/ai-pipeline.sqlite"
  );
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  sqliteDb = new BunSqliteDatabase(sqlitePath);
  sqliteDb.exec(SQLITE_SCHEMA_SQL);
  applySqliteMigrations(sqliteDb);
  kyselyDb = new Kysely<DatabaseSchema>({
    dialect: new BunSqliteDialect(sqliteDb),
  });
  activeDriver = "sqlite";
  dbLog.warn(
    { sqlitePath },
    "Primary SQL database unavailable; initialized SQLite fallback via Kysely"
  );
}

function resolvePreferredDriver(): "postgres" | "mysql" | "gauss" | "sqlite" | "auto" {
  const raw = process.env.DB_DRIVER?.trim().toLowerCase();
  if (raw === "postgres" || raw === "postgresql" || raw === "pg") return "postgres";
  if (raw === "mysql" || raw === "mysql2") return "mysql";
  if (raw === "gauss" || raw === "gaussdb" || raw === "opengauss") return "gauss";
  if (raw === "sqlite") return "sqlite";

  const dbUrl = process.env.DATABASE_URL?.trim().toLowerCase() ?? "";
  if (dbUrl.startsWith("mysql://") || dbUrl.startsWith("mysql2://")) return "mysql";
  if (dbUrl.startsWith("gaussdb://") || dbUrl.startsWith("opengauss://")) return "gauss";
  if (process.env.GAUSS_URL?.trim() || process.env.GAUSSHOST?.trim()) return "gauss";
  if (process.env.MYSQL_URL?.trim() || process.env.MYSQL_HOST?.trim()) return "mysql";

  return "auto";
}

async function seedCatalogData(): Promise<void> {
  const db = getDb();

  for (const app of INITIAL_APPS) {
    if (isMysqlDriver()) {
      await db
        .insertInto("catalog_apps")
        .ignore()
        .values({ id: app.id, name: app.name, env: app.env })
        .execute();
    } else {
      await db
        .insertInto("catalog_apps")
        .values({ id: app.id, name: app.name, env: app.env })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }
  }

  for (const repo of INITIAL_REPOS) {
    if (isMysqlDriver()) {
      await db
        .insertInto("catalog_repos")
        .ignore()
        .values({
          id: repo.id,
          name: repo.name,
          url: repo.url,
          branch: repo.branch,
        })
        .execute();
    } else {
      await db
        .insertInto("catalog_repos")
        .values({
          id: repo.id,
          name: repo.name,
          url: repo.url,
          branch: repo.branch,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }
  }
}

async function ingestBuiltinSkillsToDb(): Promise<Set<string>> {
  const db = getDb();
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
    const now = dbNow();

    const skillValues = {
      skill_name: skillName,
      description: desc,
      creator: "Built-in",
      is_builtin: toDbBool(true),
      created_at: now,
      updated_at: now,
      current_step: 3,
      progress: 100,
      status: "published",
      selected_apps: "[]",
      selected_repos: "[]",
      selected_mcps: "[]",
      pipeline_runs: "[]",
      frontmatter: JSON.stringify(frontmatter),
      has_scripts: toDbBool(hasScripts),
      resource_summary: JSON.stringify(summary),
      skill_md: skillMd.content,
    };

    const skillUpdate = {
      description: desc,
      is_builtin: toDbBool(true),
      frontmatter: JSON.stringify(frontmatter),
      has_scripts: toDbBool(hasScripts),
      resource_summary: JSON.stringify(summary),
      skill_md: skillMd.content,
    };

    if (isMysqlDriver()) {
      await db
        .insertInto("skills")
        .values(skillValues)
        .onDuplicateKeyUpdate(skillUpdate)
        .execute();
    } else {
      await db
        .insertInto("skills")
        .values(skillValues)
        .onConflict((oc) => oc.column("skill_name").doUpdateSet(skillUpdate))
        .execute();
    }

    await db
      .deleteFrom("skill_files")
      .where("skill_name", "=", skillName)
      .execute();

    for (const file of files) {
      const fileValues = {
        skill_name: skillName,
        file_path: file.path,
        content: file.content,
        category: file.category ?? "other",
        mime_type: file.mimeType ?? "text/plain",
        encoding: file.encoding ?? "utf-8",
        size_bytes: file.sizeBytes ?? 0,
        is_executable: toDbBool(Boolean(file.isExecutable)),
        updated_at: now,
      };
      const fileUpdate = {
        content: fileValues.content,
        category: fileValues.category,
        mime_type: fileValues.mime_type,
        encoding: fileValues.encoding,
        size_bytes: fileValues.size_bytes,
        is_executable: fileValues.is_executable,
        updated_at: now,
      };

      if (isMysqlDriver()) {
        await db
          .insertInto("skill_files")
          .values(fileValues)
          .onDuplicateKeyUpdate(fileUpdate)
          .execute();
      } else {
        await db
          .insertInto("skill_files")
          .values(fileValues)
          .onConflict((oc) =>
            oc.columns(["skill_name", "file_path"]).doUpdateSet(fileUpdate)
          )
          .execute();
      }
    }
  }

  return builtinNames;
}

async function syncDiskSkillsToDb(builtinNames: Set<string>): Promise<void> {
  const db = getDb();
  const diskSkills = await listSkillsInDefaultDir("global");
  for (const disk of diskSkills) {
    if (builtinNames.has(disk.skillName)) continue;

    const existing = await db
      .selectFrom("skills")
      .select("skill_name")
      .where("skill_name", "=", disk.skillName)
      .executeTakeFirst();
    if (existing) continue;

    const skillDir = path.join(resolveDefaultSkillsRoot("global"), disk.skillName);
    const files = await readSkillDirectoryFiles(skillDir);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    const mdContent = skillMd?.content ?? "";
    const frontmatter = parseSkillFrontmatter(mdContent);
    const desc = extractDescriptionFromMarkdown(mdContent, "System AI Skill");
    const { summary, hasScripts } = buildResourceSummary(files);
    const now = dbNow();

    const skillValues = {
      skill_name: disk.skillName,
      description: desc,
      creator: "System",
      is_builtin: toDbBool(false),
      created_at: now,
      updated_at: now,
      current_step: 1,
      progress: 33,
      status: "draft",
      selected_apps: "[]",
      selected_repos: "[]",
      selected_mcps: "[]",
      pipeline_runs: "[]",
      frontmatter: JSON.stringify(frontmatter),
      has_scripts: toDbBool(hasScripts),
      resource_summary: JSON.stringify(summary),
      skill_md: mdContent,
    };

    if (isMysqlDriver()) {
      await db.insertInto("skills").ignore().values(skillValues).execute();
    } else {
      await db
        .insertInto("skills")
        .values(skillValues)
        .onConflict((oc) => oc.column("skill_name").doNothing())
        .execute();
    }

    for (const file of files) {
      const fileValues = {
        skill_name: disk.skillName,
        file_path: file.path,
        content: file.content,
        category: file.category ?? "other",
        mime_type: file.mimeType ?? "text/plain",
        encoding: file.encoding ?? "utf-8",
        size_bytes: file.sizeBytes ?? 0,
        is_executable: toDbBool(Boolean(file.isExecutable)),
        updated_at: now,
      };
      if (isMysqlDriver()) {
        await db.insertInto("skill_files").ignore().values(fileValues).execute();
      } else {
        await db
          .insertInto("skill_files")
          .values(fileValues)
          .onConflict((oc) => oc.columns(["skill_name", "file_path"]).doNothing())
          .execute();
      }
    }
  }
}

export async function restoreSkillsFromDbToAgentDirs(): Promise<number> {
  const db = getDb();
  const skillRows = await db
    .selectFrom("skills")
    .select(["skill_name", "skill_md"])
    .orderBy("skill_name", "asc")
    .execute();
  if (skillRows.length === 0) return 0;

  const fileRows = await db
    .selectFrom("skill_files")
    .select([
      "skill_name",
      "file_path",
      "content",
      "category",
      "mime_type",
      "encoding",
      "size_bytes",
      "is_executable",
    ])
    .orderBy("skill_name", "asc")
    .orderBy("file_path", "asc")
    .execute();

  const filesBySkill = new Map<string, SkillFileEntry[]>();
  for (const row of fileRows) {
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

  for (const skill of skillRows) {
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

  dbLog.info(
    { restoredCount, targetRoots },
    "Restored skills from database to agent directories"
  );
  return restoredCount;
}

/**
 * Initialize database using Kysely with multi-dialect support:
 * PostgreSQL (`pg`), MySQL (`mysql2`), GaussDB/openGauss (`gaussdb-nodejs`), and SQLite (`bun:sqlite`).
 */
export async function initDatabase(): Promise<DbDriver> {
  if (activeDriver && kyselyDb) return activeDriver;

  const preferred = resolvePreferredDriver();
  const allowFallback = process.env.DB_ALLOW_SQLITE_FALLBACK !== "false";

  if (preferred === "sqlite") {
    await initSqliteFallback();
  } else if (preferred === "mysql") {
    const pool = await connectMysql();
    if (pool) {
      mysqlPool = pool;
      activeDriver = "mysql";
      for (const stmt of MYSQL_SCHEMA_STATEMENTS) {
        await mysqlPool.promise().query(stmt);
      }
      kyselyDb = new Kysely<DatabaseSchema>({
        dialect: new MysqlDialect({ pool: mysqlPool as never }),
      });
      dbLog.info("MySQL connected via mysql2 and Kysely schema initialized");
    } else if (allowFallback) {
      await initSqliteFallback();
    } else {
      throw new Error("MySQL connection failed and SQLite fallback is disabled");
    }
  } else if (preferred === "gauss") {
    const pool = await connectGauss();
    if (pool) {
      gaussPool = pool;
      activeDriver = "gauss";
      for (const stmt of GAUSS_SCHEMA_STATEMENTS) {
        await gaussPool.query(stmt);
      }
      kyselyDb = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({ pool: gaussPool as never }),
      });
      dbLog.info("GaussDB connected via gaussdb-nodejs and Kysely schema initialized");
    } else if (allowFallback) {
      await initSqliteFallback();
    } else {
      throw new Error("GaussDB connection failed and SQLite fallback is disabled");
    }
  } else {
    // PostgreSQL ("postgres" or "auto")
    let connectedPool = await connectPostgres();
    if (!connectedPool && preferred === "auto") {
      const started = await tryAutoStartLocalPostgres();
      if (started) {
        connectedPool = await connectPostgres();
      }
    }

    if (connectedPool) {
      pgPool = connectedPool;
      activeDriver = "postgres";
      await pgPool.query(PG_SCHEMA_SQL);
      kyselyDb = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({ pool: pgPool }),
      });
      dbLog.info("PostgreSQL connected via pg and Kysely schema initialized");
    } else if (allowFallback) {
      await initSqliteFallback();
    } else {
      throw new Error("PostgreSQL connection failed and SQLite fallback is disabled");
    }
  }

  if (process.env.DB_INIT_SEED !== "false") {
    await seedCatalogData();
  }
  const builtinNames = await ingestBuiltinSkillsToDb();
  await syncDiskSkillsToDb(builtinNames);
  await restoreSkillsFromDbToAgentDirs();

  return activeDriver!;
}

export async function closeDatabase(): Promise<void> {
  if (kyselyDb) {
    await kyselyDb.destroy().catch(() => {});
    kyselyDb = null;
  }
  if (pgPool) {
    await pgPool.end().catch(() => {});
    pgPool = null;
  }
  if (gaussPool) {
    await gaussPool.end().catch(() => {});
    gaussPool = null;
  }
  if (mysqlPool) {
    await mysqlPool.promise().end().catch(() => {});
    mysqlPool = null;
  }
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {
      // Ignore close error
    }
    sqliteDb = null;
  }
  activeDriver = null;
}
