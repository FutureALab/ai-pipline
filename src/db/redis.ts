import Redis, {
  Cluster,
  type ClusterNode,
  type ClusterOptions,
  type RedisOptions,
} from "ioredis";
import { createLogger } from "../config/logger.js";

const log = createLogger("redis");

export type RedisClient = Redis | Cluster;
export type RedisMode = "cluster" | "standalone" | "disabled";

let redisClient: RedisClient | null = null;
let redisReady = false;
let activeMode: RedisMode = "disabled";

export function isRedisConnected(): boolean {
  return redisReady && redisClient !== null;
}

export function getRedisMode(): RedisMode {
  return activeMode;
}

export function getRedisClient(): RedisClient {
  if (!redisClient) {
    throw new Error("Redis client is not initialized");
  }
  return redisClient;
}

/**
 * Hash-tag key prefix required by BullMQ and multi-key operations on Redis Cluster.
 * Defaults to `{ai_pipeline}` so all queue keys land on the same hash slot.
 */
export function getRedisKeyPrefix(): string {
  const raw = process.env.REDIS_KEY_PREFIX?.trim();
  if (!raw) return "{ai_pipeline}";
  return raw.includes("{") && raw.includes("}") ? raw : `{${raw}}`;
}

function parseClusterNodes(): ClusterNode[] {
  const raw = process.env.REDIS_CLUSTER_NODES?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const cleaned = entry.replace(/^rediss?:\/\//i, "");
      const lastColon = cleaned.lastIndexOf(":");
      if (lastColon === -1) {
        return { host: cleaned, port: 6379 };
      }
      const host = cleaned.slice(0, lastColon) || "127.0.0.1";
      const port = Number(cleaned.slice(lastColon + 1)) || 6379;
      return { host, port };
    });
}

function parseNatMap(): ClusterOptions["natMap"] | undefined {
  const raw = process.env.REDIS_CLUSTER_NAT_MAP?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ClusterOptions["natMap"];
  } catch (err) {
    log.warn({ err }, "Invalid REDIS_CLUSTER_NAT_MAP JSON; ignoring");
    return undefined;
  }
}

function resolveConfiguredMode(): "cluster" | "standalone" {
  const envMode = process.env.REDIS_MODE?.trim().toLowerCase();
  if (envMode === "cluster") return "cluster";
  if (envMode === "standalone") return "standalone";
  if (parseClusterNodes().length > 0) return "cluster";
  return "standalone";
}

function buildBaseRedisOptions(forBlocking: boolean): RedisOptions {
  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  const username = process.env.REDIS_USERNAME?.trim() || undefined;
  return {
    username,
    password,
    connectTimeout: 5_000,
    maxRetriesPerRequest: forBlocking ? null : 2,
    enableReadyCheck: !forBlocking,
  };
}

function buildClusterClient(forBlocking: boolean): Cluster {
  const nodes = parseClusterNodes();
  const effectiveNodes: ClusterNode[] =
    nodes.length > 0
      ? nodes
      : [
          {
            host: process.env.REDIS_HOST?.trim() || "127.0.0.1",
            port: Number(process.env.REDIS_PORT || 7001),
          },
        ];

  const natMap = parseNatMap();
  const options: ClusterOptions = {
    lazyConnect: !forBlocking,
    scaleReads: "master",
    enableReadyCheck: true,
    clusterRetryStrategy: (times: number) => {
      if (!forBlocking && times > 3) return null;
      return Math.min(times * 200, 2_000);
    },
    redisOptions: buildBaseRedisOptions(forBlocking),
    ...(natMap ? { natMap } : {}),
  };

  return new Cluster(effectiveNodes, options);
}

function buildStandaloneClient(forBlocking: boolean): Redis {
  const redisUrl = process.env.REDIS_URL?.trim();
  const baseOptions: RedisOptions = {
    ...buildBaseRedisOptions(forBlocking),
    lazyConnect: !forBlocking,
    retryStrategy: (times: number) => {
      if (!forBlocking && times > 3) return null;
      return Math.min(times * 200, 2_000);
    },
  };

  if (redisUrl) {
    return new Redis(redisUrl, baseOptions);
  }

  return new Redis({
    ...baseOptions,
    host: process.env.REDIS_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0),
  });
}

/**
 * Create a dedicated Redis/Cluster connection for blocking commands (BLPOP, BullMQ Worker)
 * so the shared command connection is never blocked.
 * Note: `ioredis` Cluster does not support `.duplicate()`, so a fresh Cluster instance is created.
 */
export function createBlockingRedisClient(): RedisClient | null {
  if (!redisReady || !redisClient) return null;

  const client =
    activeMode === "cluster"
      ? buildClusterClient(true)
      : buildStandaloneClient(true);

  client.on("error", (err: Error) => {
    log.warn({ err, mode: activeMode }, "Blocking Redis connection warning");
  });

  return client;
}

/**
 * Create a BullMQ-compatible Redis/Cluster connection (`maxRetriesPerRequest: null`).
 */
export function createBullMQConnection(): RedisClient | null {
  return createBlockingRedisClient();
}

/**
 * Initialize Redis connection on startup (supports Redis Cluster and Standalone).
 */
export async function initRedis(): Promise<boolean> {
  if (redisReady && redisClient) return true;

  if (process.env.REDIS_ENABLED === "false") {
    activeMode = "disabled";
    log.info("Redis disabled via REDIS_ENABLED=false");
    return false;
  }

  const mode = resolveConfiguredMode();
  const client: RedisClient =
    mode === "cluster"
      ? buildClusterClient(false)
      : buildStandaloneClient(false);

  client.on("error", (err: Error) => {
    if (redisReady) {
      log.warn({ err, mode }, "Redis connection warning");
    }
  });

  try {
    await client.connect();
    await client.ping();
    redisClient = client;
    redisReady = true;
    activeMode = mode;
    log.info(
      {
        mode,
        prefix: getRedisKeyPrefix(),
        ...(mode === "cluster" ? { nodes: parseClusterNodes() } : {}),
      },
      `Redis (${mode}) connected and ready`
    );
    return true;
  } catch (err) {
    await client.quit().catch(() => client.disconnect());
    redisClient = null;
    redisReady = false;
    activeMode = "disabled";
    const msg = err instanceof Error ? err.message : String(err);

    if (process.env.REDIS_ALLOW_FALLBACK !== "false") {
      log.warn(
        { mode, reason: msg },
        "Redis unavailable; continuing with in-memory fallback"
      );
      return false;
    }

    log.error({ err, mode }, "Redis connection failed");
    throw new Error(`Redis (${mode}) connection failed: ${msg}`);
  }
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;
  await redisClient.quit().catch(() => redisClient?.disconnect());
  redisClient = null;
  redisReady = false;
  activeMode = "disabled";
  log.info("Redis connection closed");
}
