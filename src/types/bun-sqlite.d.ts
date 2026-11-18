declare module "bun:sqlite" {
  export class Statement<T = unknown> {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
    run(...params: unknown[]): void;
  }

  export class Database {
    constructor(filename?: string, options?: number | Record<string, unknown>);
    exec(sql: string): void;
    query<T = unknown>(sql: string): Statement<T>;
    close(): void;
  }
}
