import crypto from "node:crypto";
import { decryptIfEncrypted, encryptSecret } from "../config/crypto.js";
import { createLogger } from "../config/logger.js";
import {
  DEFAULT_REDIS_NAME,
  getRedisClient,
  getRedisKeyPrefix,
  isRedisConnected,
} from "./redis.js";

const cacheLog = createLogger("redis-adapter");

export interface RedisAdapterOptions {
  /** Named Redis instance from `src/db/redis.ts` (defaults to "primary"). */
  instanceName?: string;
  /** Logical namespace inside Redis (combined with hash-tag prefix). */
  namespace?: string;
  /** Default TTL in seconds (default 60s). */
  defaultTtlSeconds?: number;
  /** When true, encrypts values with Jasypt ENC(...) before storing in Redis. */
  encryptValues?: boolean;
}

/**
 * Typed Redis Adapter over our multi-instance Redis registry (Sentinel / Cluster / Standalone).
 * Handles hash-tag key prefixing, JSON serialization, TTL, and optional Jasypt ENC(...) encryption.
 */
export class RedisAdapter {
  private readonly instanceName: string;
  private readonly namespace: string;
  private readonly defaultTtlSeconds: number;
  private readonly encryptValues: boolean;

  constructor(options: RedisAdapterOptions = {}) {
    this.instanceName = options.instanceName?.trim() || DEFAULT_REDIS_NAME;
    this.namespace = options.namespace?.trim() || "cache";
    this.defaultTtlSeconds = Math.max(1, Math.floor(options.defaultTtlSeconds ?? 60));
    this.encryptValues = Boolean(options.encryptValues);
  }

  public isReady(): boolean {
    return isRedisConnected(this.instanceName);
  }

  public buildKey(key: string): string {
    const prefix = getRedisKeyPrefix(this.instanceName);
    return `${prefix}:${this.namespace}:${key}`;
  }

  public async get<T>(key: string): Promise<T | null> {
    if (!this.isReady()) return null;
    try {
      const raw = await getRedisClient(this.instanceName).get(this.buildKey(key));
      if (raw === null) return null;
      const plain = this.encryptValues ? decryptIfEncrypted(raw) : raw;
      return JSON.parse(plain) as T;
    } catch (err) {
      cacheLog.warn({ err, key, instance: this.instanceName }, "RedisAdapter get failed");
      return null;
    }
  }

  public async set<T>(
    key: string,
    value: T,
    ttlSeconds: number = this.defaultTtlSeconds
  ): Promise<boolean> {
    if (!this.isReady()) return false;
    try {
      const serialized = JSON.stringify(value, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      );
      const stored = this.encryptValues ? encryptSecret(serialized) : serialized;
      await getRedisClient(this.instanceName).set(
        this.buildKey(key),
        stored,
        "EX",
        Math.max(1, Math.floor(ttlSeconds))
      );
      return true;
    } catch (err) {
      cacheLog.warn({ err, key, instance: this.instanceName }, "RedisAdapter set failed");
      return false;
    }
  }

  public async del(key: string): Promise<void> {
    if (!this.isReady()) return;
    await getRedisClient(this.instanceName)
      .del(this.buildKey(key))
      .catch(() => {});
  }

  /**
   * Read-through cache helper: returns cached value if present in Redis,
   * otherwise runs `loader()`, caches the result, and returns it.
   */
  public async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    ttlSeconds: number = this.defaultTtlSeconds
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const fresh = await loader();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }
}

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

export interface PrismaRedisCacheOptions {
  /** Named Redis instance (defaults to "primary"). */
  redisInstance?: string;
  /** Default cache TTL in seconds (default 30s). */
  ttlSeconds?: number;
  /** Optional list of Prisma model names to cache (default: CatalogApp, CatalogRepo, Skill). */
  models?: string[];
}

/**
 * Create a Prisma Client Extension (`$extends`) backed by our RedisAdapter.
 * - Caches read queries (`findMany`, `findUnique`, `count`, ...) in Redis with TTL.
 * - Automatically bumps the model's cache version key on any write (`create`, `update`, `upsert`, `delete`),
 *   so stale entries are invalidated cleanly without expensive `KEYS *` scans (Sentinel & Cluster safe).
 */
export function createPrismaRedisCacheExtension(
  options: PrismaRedisCacheOptions = {}
) {
  const instanceName = options.redisInstance?.trim() || DEFAULT_REDIS_NAME;
  const ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds ?? 30));
  const cachedModels = new Set(
    options.models ?? ["CatalogApp", "CatalogRepo"]
  );
  const adapter = new RedisAdapter({
    instanceName,
    namespace: "prisma-cache",
    defaultTtlSeconds: ttlSeconds,
  });

  async function getModelVersion(model: string): Promise<string> {
    const v = await adapter.get<number>(`ver:${model}`);
    return String(v ?? 0);
  }

  async function bumpModelVersion(model: string): Promise<void> {
    if (!adapter.isReady()) return;
    try {
      await getRedisClient(instanceName).incr(adapter.buildKey(`ver:${model}`));
    } catch {
      // ignore
    }
  }

  return {
    name: "prisma-redis-cache-adapter",
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }) {
          if (!model || !cachedModels.has(model) || !adapter.isReady()) {
            return query(args);
          }

          if (WRITE_OPERATIONS.has(operation)) {
            const result = await query(args);
            await bumpModelVersion(model);
            return result;
          }

          if (READ_OPERATIONS.has(operation)) {
            const ver = await getModelVersion(model);
            const argsHash = crypto
              .createHash("sha1")
              .update(
                JSON.stringify(args ?? {}, (_k, v) =>
                  typeof v === "bigint" ? v.toString() : v
                )
              )
              .digest("hex");
            const cacheKey = `${model}:v${ver}:${operation}:${argsHash}`;
            return adapter.getOrLoad(cacheKey, () => query(args), ttlSeconds);
          }

          return query(args);
        },
      },
    },
  };
}
