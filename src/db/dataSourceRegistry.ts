import { Database as BunSqliteDatabase } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool as GaussPool } from "gaussdb-nodejs";
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { createPool as createMysqlPool, type Pool as MysqlPool } from "mysql2";
import { Pool as PgPool } from "pg";
import {
  decryptConnectionUrl,
  decryptIfEncrypted,
} from "../config/crypto.js";
import { createLogger } from "../config/logger.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaClient as MysqlPrismaClient } from "../generated/prisma-mysql/client.js";
import { BunSqliteDialect } from "./bunSqliteDialect.js";
import { createPrismaRedisCacheExtension } from "./prismaRedisCache.js";
import type { DatabaseSchema } from "./schema.js";

const dsLog = createLogger("datasource");

export const DEFAULT_DATASOURCE_NAME = "primary";

export type DbDriver = "postgres" | "mysql" | "gauss" | "sqlite";

export interface DataSourceConfig {
  /** Unique logical datasource name (e.g. "primary", "dept_hr", "order_mysql", "dw_gauss"). */
  name: string;
  driver: DbDriver;
  /** Optional connection URL (supports Jasypt ENC(...) whole URL or embedded password). */
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  /** Supports Jasypt ENC(...) ciphertext. */
  password?: string;
  database?: string;
  sqlitePath?: string;
  maxConnections?: number;
  /** When true (default for secondary datasources), connection failure logs a warning without crashing boot. */
  allowFailure?: boolean;
}

export interface DataSourceStatusSnapshot {
  name: string;
  driver: DbDriver | null;
  connected: boolean;
  error?: string;
}

export interface ManagedDataSource {
  name: string;
  driver: DbDriver;
  kysely: Kysely<any>;
  prisma?: PrismaClient;
  prismaMysql?: MysqlPrismaClient;
  pgPool?: PgPool;
  gaussPool?: GaussPool;
  mysqlPool?: MysqlPool;
  sqliteDb?: BunSqliteDatabase;
}

const registry = new Map<string, ManagedDataSource>();
const failedDataSources = new Map<string, { driver: DbDriver; error: string }>();

export function registerManagedDataSource(ds: ManagedDataSource): void {
  failedDataSources.delete(ds.name);
  registry.set(ds.name, ds);
}

export function getManagedDataSource(
  name: string = DEFAULT_DATASOURCE_NAME
): ManagedDataSource | undefined {
  return registry.get(name);
}

/**
 * Returns a Kysely query builder for the requested named datasource (defaults to "primary").
 * Allows simultaneous strongly-typed queries across PostgreSQL, MySQL, GaussDB, and SQLite.
 */
export function getNamedDb<TSchema = DatabaseSchema>(
  name: string = DEFAULT_DATASOURCE_NAME
): Kysely<TSchema> {
  const ds = registry.get(name);
  if (!ds) {
    throw new Error(
      `Database datasource "${name}" is not initialized or unavailable.`
    );
  }
  return ds.kysely as Kysely<TSchema>;
}

/**
 * Returns the PrismaClient instance for the named datasource (PostgreSQL / GaussDB).
 */
export function getNamedPrisma(
  name: string = DEFAULT_DATASOURCE_NAME
): PrismaClient {
  const ds = registry.get(name);
  if (!ds?.prisma) {
    throw new Error(
      `PrismaClient for datasource "${name}" is not initialized (driver=${ds?.driver ?? "none"}).`
    );
  }
  return ds.prisma;
}

/**
 * Returns PrismaClient for the named datasource, or null if using SQLite/MySQL fallback.
 */
export function getNamedPrismaOrNull(
  name: string = DEFAULT_DATASOURCE_NAME
): PrismaClient | null {
  return registry.get(name)?.prisma ?? null;
}

export function createPrismaPgClient(pool: PgPool | GaussPool): PrismaClient {
  const adapter = new PrismaPg(pool as never);
  const base = new PrismaClient({ adapter });
  if (process.env.PRISMA_REDIS_CACHE === "false") {
    return base;
  }
  return base.$extends(createPrismaRedisCacheExtension()) as unknown as PrismaClient;
}

export interface MysqlAdapterPoolParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

export function createPrismaMysqlClient(
  params: MysqlAdapterPoolParams
): MysqlPrismaClient {
  const adapter = new PrismaMariaDb({
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password,
    database: params.database,
    connectionLimit: params.connectionLimit ?? 10,
  });
  const base = new MysqlPrismaClient({ adapter });
  if (process.env.PRISMA_REDIS_CACHE === "false") {
    return base;
  }
  return base.$extends(createPrismaRedisCacheExtension()) as unknown as MysqlPrismaClient;
}

export function getNamedMysqlPrisma(
  name: string = DEFAULT_DATASOURCE_NAME
): MysqlPrismaClient {
  const ds = registry.get(name);
  if (!ds?.prismaMysql) {
    throw new Error(
      `MySQL PrismaClient for datasource "${name}" is not initialized (driver=${ds?.driver ?? "none"}).`
    );
  }
  return ds.prismaMysql;
}

export function getNamedMysqlPrismaOrNull(
  name: string = DEFAULT_DATASOURCE_NAME
): MysqlPrismaClient | null {
  return registry.get(name)?.prismaMysql ?? null;
}

export function isDataSourceConnected(
  name: string = DEFAULT_DATASOURCE_NAME
): boolean {
  return registry.has(name);
}

export function getDataSourceDriver(
  name: string = DEFAULT_DATASOURCE_NAME
): DbDriver | null {
  return registry.get(name)?.driver ?? null;
}

export function listDataSources(): DataSourceStatusSnapshot[] {
  const out: DataSourceStatusSnapshot[] = [];
  for (const ds of registry.values()) {
    out.push({
      name: ds.name,
      driver: ds.driver,
      connected: true,
    });
  }
  for (const [name, info] of failedDataSources.entries()) {
    if (!registry.has(name)) {
      out.push({
        name,
        driver: info.driver,
        connected: false,
        error: info.error,
      });
    }
  }
  return out;
}

/**
 * Execute a raw parameterized SQL query against ANY named datasource
 * (useful for cross-department ad-hoc queries on external schemas).
 */
export async function queryDataSource<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  name: string,
  sqlText: string,
  params: unknown[] = []
): Promise<{ rows: T[] }> {
  const ds = registry.get(name);
  if (!ds) {
    throw new Error(`Datasource "${name}" is not initialized or unavailable.`);
  }

  if (ds.driver === "postgres" && ds.pgPool) {
    const res = await ds.pgPool.query<T>(sqlText, params);
    return { rows: res.rows };
  }

  if (ds.driver === "gauss" && ds.gaussPool) {
    const res = await ds.gaussPool.query<T>(sqlText, params);
    return { rows: res.rows };
  }

  if (ds.driver === "mysql" && ds.mysqlPool) {
    const mysqlParams: unknown[] = [];
    const convertedSql = sqlText
      .replace(/::jsonb/gi, "")
      .replace(/\$(\d+)/g, (_m, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        const val = params[idx];
        mysqlParams.push(
          typeof val === "boolean" ? (val ? 1 : 0) : (val ?? null)
        );
        return "?";
      });
    const [rows] = await ds.mysqlPool
      .promise()
      .query(convertedSql, mysqlParams);
    return { rows: Array.isArray(rows) ? (rows as T[]) : [] };
  }

  if (ds.driver === "sqlite" && ds.sqliteDb) {
    const sqliteParams: unknown[] = [];
    const convertedSql = sqlText
      .replace(/::jsonb/gi, "")
      .replace(/NOW\(\)/gi, "CURRENT_TIMESTAMP")
      .replace(/\$(\d+)/g, (_m, idxStr: string) => {
        const idx = Number(idxStr) - 1;
        const val = params[idx];
        sqliteParams.push(
          typeof val === "boolean" ? (val ? 1 : 0) : (val ?? null)
        );
        return "?";
      });

    const trimmed = convertedSql.trim().toUpperCase();
    const stmt = ds.sqliteDb.query(convertedSql);
    if (trimmed.startsWith("SELECT") || trimmed.includes("RETURNING")) {
      const rows = stmt.all(...(sqliteParams as never[])) as T[];
      return { rows };
    }
    stmt.run(...(sqliteParams as never[]));
    return { rows: [] };
  }

  throw new Error(`Unsupported driver state for datasource "${name}"`);
}

/**
 * Connect and register an additional named datasource (PG / MySQL / GaussDB / SQLite).
 */
export async function registerDataSource(
  config: DataSourceConfig
): Promise<boolean> {
  const name = config.name.trim();
  if (!name) {
    throw new Error("DataSource `name` is required");
  }
  if (registry.has(name)) {
    return true;
  }

  const max = config.maxConnections ?? 10;
  try {
    if (config.driver === "postgres") {
      const url = decryptConnectionUrl(config.url);
      const pool = new PgPool(
        url
          ? {
              connectionString: url,
              max,
              idleTimeoutMillis: 30_000,
              connectionTimeoutMillis: 5_000,
            }
          : {
              host: config.host?.trim() || "127.0.0.1",
              port: Number(config.port || 5432),
              user: config.user?.trim() || "postgres",
              password: decryptIfEncrypted(config.password),
              database: config.database?.trim() || "postgres",
              max,
              idleTimeoutMillis: 30_000,
              connectionTimeoutMillis: 5_000,
            }
      );
      await pool.query("SELECT 1");
      registerManagedDataSource({
        name,
        driver: "postgres",
        pgPool: pool,
        prisma: createPrismaPgClient(pool),
        kysely: new Kysely({ dialect: new PostgresDialect({ pool }) }),
      });
      dsLog.info({ name, driver: "postgres" }, `Secondary datasource "${name}" connected (Prisma + Kysely)`);
      return true;
    }

    if (config.driver === "gauss") {
      const rawUrl = decryptConnectionUrl(config.url);
      const normalizedUrl = rawUrl
        ? rawUrl.replace(/^(gaussdb|opengauss):\/\//i, "postgresql://")
        : "";
      const pool = new GaussPool(
        normalizedUrl
          ? {
              connectionString: normalizedUrl,
              max,
              idleTimeoutMillis: 30_000,
              connectionTimeoutMillis: 5_000,
              sha256Iterations: "server",
            }
          : {
              host: config.host?.trim() || "127.0.0.1",
              port: Number(config.port || 8000),
              user: config.user?.trim() || "gaussdb",
              password: decryptIfEncrypted(config.password),
              database: config.database?.trim() || "postgres",
              max,
              idleTimeoutMillis: 30_000,
              connectionTimeoutMillis: 5_000,
              sha256Iterations: "server",
            }
      );
      await pool.query("SELECT 1");
      registerManagedDataSource({
        name,
        driver: "gauss",
        gaussPool: pool,
        prisma: createPrismaPgClient(pool),
        kysely: new Kysely({ dialect: new PostgresDialect({ pool: pool as never }) }),
      });
      dsLog.info({ name, driver: "gauss" }, `Secondary datasource "${name}" connected (Prisma + Kysely)`);
      return true;
    }

    if (config.driver === "mysql") {
      const rawUrl = decryptConnectionUrl(config.url);
      let mysqlParams: MysqlAdapterPoolParams;
      if (rawUrl) {
        const parsed = new URL(rawUrl.replace(/^mysql2:\/\//i, "mysql://"));
        mysqlParams = {
          host: parsed.hostname || "127.0.0.1",
          port: Number(parsed.port || 3306),
          user: decodeURIComponent(parsed.username || "root"),
          password: decryptIfEncrypted(decodeURIComponent(parsed.password || "")),
          database: parsed.pathname.replace(/^\//, "") || "mysql",
          connectionLimit: max,
        };
      } else {
        mysqlParams = {
          host: config.host?.trim() || "127.0.0.1",
          port: Number(config.port || 3306),
          user: config.user?.trim() || "root",
          password: decryptIfEncrypted(config.password),
          database: config.database?.trim() || "mysql",
          connectionLimit: max,
        };
      }
      const pool = createMysqlPool({
        ...mysqlParams,
        connectTimeout: 5_000,
        charset: "utf8mb4",
      });
      await pool.promise().query("SELECT 1");
      registerManagedDataSource({
        name,
        driver: "mysql",
        mysqlPool: pool,
        prismaMysql: createPrismaMysqlClient(mysqlParams),
        kysely: new Kysely({ dialect: new MysqlDialect({ pool: pool as never }) }),
      });
      dsLog.info(
        { name, driver: "mysql" },
        `Secondary datasource "${name}" connected (PrismaMariaDb + Kysely)`
      );
      return true;
    }

    if (config.driver === "sqlite") {
      const sqlitePath = path.resolve(
        process.cwd(),
        config.sqlitePath?.trim() || `data/${name}.sqlite`
      );
      await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
      const db = new BunSqliteDatabase(sqlitePath);
      registerManagedDataSource({
        name,
        driver: "sqlite",
        sqliteDb: db,
        kysely: new Kysely({ dialect: new BunSqliteDialect(db) }),
      });
      dsLog.info(
        { name, driver: "sqlite", sqlitePath },
        `Secondary datasource "${name}" connected`
      );
      return true;
    }

    throw new Error(`Unsupported driver "${config.driver}" for datasource "${name}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failedDataSources.set(name, { driver: config.driver, error: msg });
    if (config.allowFailure !== false) {
      dsLog.warn(
        { name, driver: config.driver, reason: msg },
        `Secondary datasource "${name}" unavailable; continuing startup`
      );
      return false;
    }
    throw new Error(`Datasource "${name}" (${config.driver}) connection failed: ${msg}`);
  }
}

/**
 * Parse and initialize all secondary datasources configured via `DB_DATASOURCES` JSON array.
 */
export async function initConfiguredSecondaryDataSources(): Promise<void> {
  const raw = process.env.DB_DATASOURCES?.trim();
  if (!raw) return;

  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    dsLog.warn({ err }, "Invalid DB_DATASOURCES JSON; ignoring secondary datasources");
    return;
  }

  if (!Array.isArray(list)) return;

  await Promise.all(
    list
      .filter(
        (item): item is DataSourceConfig =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as DataSourceConfig).name === "string" &&
          typeof (item as DataSourceConfig).driver === "string"
      )
      .map((cfg) =>
        registerDataSource({
          ...cfg,
          name: cfg.name.trim(),
          allowFailure: cfg.allowFailure !== false,
        })
      )
  );
}

export async function closeAllDataSources(): Promise<void> {
  for (const ds of registry.values()) {
    if (ds.prisma) await ds.prisma.$disconnect().catch(() => {});
    if (ds.prismaMysql) await ds.prismaMysql.$disconnect().catch(() => {});
    await ds.kysely.destroy().catch(() => {});
    if (ds.pgPool) await ds.pgPool.end().catch(() => {});
    if (ds.gaussPool) await ds.gaussPool.end().catch(() => {});
    if (ds.mysqlPool) await ds.mysqlPool.promise().end().catch(() => {});
    if (ds.sqliteDb) {
      try {
        ds.sqliteDb.close();
      } catch {
        // ignore
      }
    }
  }
  registry.clear();
  failedDataSources.clear();
}
