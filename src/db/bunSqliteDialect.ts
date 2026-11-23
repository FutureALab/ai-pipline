import type { Database as BunSqliteDatabase } from "bun:sqlite";
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: BunSqliteDatabase) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const params = compiledQuery.parameters.map((val) => {
      if (typeof val === "boolean") return val ? 1 : 0;
      if (val instanceof Date) return val.toISOString();
      return val ?? null;
    });

    const stmt = this.db.query(compiledQuery.sql);
    const trimmed = compiledQuery.sql.trim().toUpperCase();
    const returnsRows =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH") ||
      trimmed.includes("RETURNING");

    if (returnsRows) {
      const rows = stmt.all(...(params as never[])) as R[];
      return { rows };
    }

    const result = stmt.run(...(params as never[])) as
      | { changes?: number; lastInsertRowid?: number | bigint }
      | undefined;

    return {
      rows: [],
      numAffectedRows:
        result?.changes !== undefined ? BigInt(result.changes) : undefined,
      insertId:
        result?.lastInsertRowid !== undefined
          ? BigInt(result.lastInsertRowid)
          : undefined,
    };
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery
  ): AsyncIterableIterator<QueryResult<R>> {
    const res = await this.executeQuery<R>(compiledQuery);
    yield res;
  }
}

class BunSqliteDriver implements Driver {
  private connection: BunSqliteConnection | null = null;

  constructor(private readonly db: BunSqliteDatabase) {}

  async init(): Promise<void> {
    this.connection = new BunSqliteConnection(this.db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.connection) {
      this.connection = new BunSqliteConnection(this.db);
    }
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {
    // Single-file embedded DB; nothing to release
  }

  async destroy(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Ignore close error
    }
    this.connection = null;
  }
}

/**
 * Lightweight Kysely Dialect backed by Bun's built-in `bun:sqlite`.
 */
export class BunSqliteDialect implements Dialect {
  constructor(private readonly db: BunSqliteDatabase) {}

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.db);
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
}
