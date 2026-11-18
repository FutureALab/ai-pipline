import Redis from "ioredis";

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
 * Initialize Redis connection on startup (for user auth lookup, caching, etc.).
 */
export async function initRedis(): Promise<boolean> {
  if (redisReady && redisClient) return true;

  if (process.env.REDIS_ENABLED === "false") {
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
      console.warn(`[Redis] Connection warning: ${err.message}`);
    }
  });

  try {
    await client.connect();
    await client.ping();
    redisClient = client;
    redisReady = true;
    console.log("[Redis] Connected and ready.");
    return true;
  } catch (err) {
    await client.quit().catch(() => client.disconnect());
    redisClient = null;
    redisReady = false;
    const msg = err instanceof Error ? err.message : String(err);

    if (process.env.REDIS_ALLOW_FALLBACK !== "false") {
      console.warn(`[Redis] Unavailable (${msg}); continuing without Redis.`);
      return false;
    }

    throw new Error(`Redis connection failed: ${msg}`);
  }
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;
  await redisClient.quit().catch(() => redisClient?.disconnect());
  redisClient = null;
  redisReady = false;
}
