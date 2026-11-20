import Redis from "ioredis";
import { createLogger } from "../config/logger.js";

const log = createLogger("redis");

let redisClient: Redis | null = null;
let redisReady = false;

export function isRedisConnected(): boolean {
  return redisReady && redisClient !== null;
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error("Redis client is not initialized");
  }
  return redisClient;
}

/**
 * Create a dedicated Redis connection for blocking commands (e.g. BLPOP)
 * so the shared command connection is never blocked.
 */
export function createBlockingRedisClient(): Redis | null {
  if (!redisReady || !redisClient) return null;
  return redisClient.duplicate({
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

/**
 * Initialize Redis connection on startup (for user auth lookup, caching, etc.).
 */
export async function initRedis(): Promise<boolean> {
  if (redisReady && redisClient) return true;

  if (process.env.REDIS_ENABLED === "false") {
    log.info("Redis disabled via REDIS_ENABLED=false");
    return false;
  }

  const redisUrl = process.env.REDIS_URL?.trim();
  const client = redisUrl
    ? new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
      })
    : new Redis({
        host: process.env.REDIS_HOST?.trim() || "localhost",
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD?.trim() || undefined,
        db: Number(process.env.REDIS_DB || 0),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
      });

  client.on("error", (err: Error) => {
    if (redisReady) {
      log.warn({ err }, "Redis connection warning");
    }
  });

  try {
    await client.connect();
    await client.ping();
    redisClient = client;
    redisReady = true;
    log.info("Connected and ready");
    return true;
  } catch (err) {
    await client.quit().catch(() => client.disconnect());
    redisClient = null;
    redisReady = false;
    const msg = err instanceof Error ? err.message : String(err);

    if (process.env.REDIS_ALLOW_FALLBACK !== "false") {
      log.warn({ reason: msg }, "Redis unavailable; continuing without Redis");
      return false;
    }

    log.error({ err }, "Redis connection failed");
    throw new Error(`Redis connection failed: ${msg}`);
  }
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;
  await redisClient.quit().catch(() => redisClient?.disconnect());
  redisClient = null;
  redisReady = false;
  log.info("Redis connection closed");
}
