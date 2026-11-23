declare module "gaussdb-nodejs" {
  import type {
    Client as PgClient,
    ClientConfig as PgClientConfig,
    Pool as PgPool,
    PoolClient as PgPoolClient,
    PoolConfig as PgPoolConfig,
    QueryResult as PgQueryResult,
    QueryResultRow as PgQueryResultRow,
  } from "pg";

  export interface GaussPoolConfig extends PgPoolConfig {
    sha256Iterations?: number | "server";
  }

  export interface GaussClientConfig extends PgClientConfig {
    sha256Iterations?: number | "server";
  }

  export class Pool extends PgPool {
    constructor(config?: GaussPoolConfig);
  }

  export class Client extends PgClient {
    constructor(config?: string | GaussClientConfig);
  }

  export type PoolClient = PgPoolClient;
  export type QueryResult<R extends PgQueryResultRow = PgQueryResultRow> =
    PgQueryResult<R>;

  const defaultExport: {
    Pool: typeof Pool;
    Client: typeof Client;
  };
  export default defaultExport;
}
