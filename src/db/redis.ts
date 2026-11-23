import Redis, {
  Cluster,
  type ClusterNode,
  type ClusterOptions,
  type RedisOptions,
} from "ioredis";
import {
  decryptConnectionUrl,
  decryptIfEncrypted,
} from "../config/crypto.js";
import { createLogger } from "../config/logger.js";

const log = createLogger("redis");

export const DEFAULT_REDIS_NAME = "primary";

export type RedisClient = Redis | Cluster;
export type RedisMode = "sentinel" | "cluster" | "standalone" | "disabled";

export interface HostPort {
  host: string;
  port: number;
}

export interface RedisInstanceConfig {
  /** Unique logical name (e.g. "primary", "sso", "dept-order-cache"). */
  name: string;
  mode?: "sentinel" | "cluster" | "standalone";
  // Sentinel options
  sentinels?: HostPort[] | string;
  masterName?: string;
  sentinelPassword?: string;
  role?: "master" | "slave";
  sentinelNatMap?: ClusterOptions["natMap"];
  // Cluster options
  clusterNodes?: HostPort[] | string;
  natMap?: ClusterOptions["natMap"];
  // Standalone options
  url?: string;
  host?: string;
  port?: number;
  // Common options (all secrets support Jasypt ENC(...))
  username?: string;
  password?: string;
  db?: number;
  keyPrefix?: string;
  allowFallback?: boolean;
}

export interface RedisInstanceStatus {
  name: string;
  mode: RedisMode;
  connected: boolean;
  keyPrefix: string;
}

interface RedisInstanceEntry {
  name: string;
  config: RedisInstanceConfig;
  mode: RedisMode;
  keyPrefix: string;
  client: RedisClient | null;
  ready: boolean;
}

const instances = new Map<string, RedisInstanceEntry>();

function normalizeKeyPrefix(raw?: string): string {
  const cleaned = raw?.trim();
  if (!cleaned) return "{ai_pipeline}";
  return cleaned.includes("{") && cleaned.includes("}") ? cleaned : `{${cleaned}}`;
}

function parseHostPortList(
  raw: HostPort[] | string | undefined,
  defaultPort: number
): HostPort[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((n) => n && typeof n.host === "string" && n.host.trim())
      .map((n) => ({
        host: n.host.trim(),
        port: Number(n.port) || defaultPort,
      }));
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const cleaned = entry.replace(/^rediss?:\/\//i, "");
      const lastColon = cleaned.lastIndexOf(":");
      if (lastColon === -1) {
        return { host: cleaned, port: defaultPort };
      }
      const host = cleaned.slice(0, lastColon) || "127.0.0.1";
      const port = Number(cleaned.slice(lastColon + 1)) || defaultPort;
      return { host, port };
    });
}

function parseNatMap(raw: string | undefined): ClusterOptions["natMap"] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw) as ClusterOptions["natMap"];
  } catch (err) {
    log.warn({ err }, "Invalid REDIS_CLUSTER_NAT_MAP JSON; ignoring");
    return undefined;
  }
}

function resolveInstanceMode(cfg: RedisInstanceConfig): "sentinel" | "cluster" | "standalone" {
  const mode = cfg.mode?.toLowerCase();
  if (mode === "sentinel") return "sentinel";
  if (mode === "cluster") return "cluster";
  if (mode === "standalone") return "standalone";
  if (parseHostPortList(cfg.sentinels, 26379).length > 0) return "sentinel";
  if (parseHostPortList(cfg.clusterNodes, 7001).length > 0) return "cluster";
  return "standalone";
}

function buildBaseRedisOptions(
  cfg: RedisInstanceConfig,
  forBlocking: boolean
): RedisOptions {
  const password = decryptIfEncrypted(cfg.password) || undefined;
  const username = cfg.username?.trim() || undefined;
  return {
    username,
    password,
    connectTimeout: 5_000,
    maxRetriesPerRequest: forBlocking ? null : 2,
    enableReadyCheck: !forBlocking,
  };
}

function buildEffectiveSentinelNatMap(
  sentinels: HostPort[],
  explicitNatMap?: ClusterOptions["natMap"]
): ClusterOptions["natMap"] | undefined {
  const isLocalSentinel = sentinels.some(
    (s) => s.host === "127.0.0.1" || s.host === "localhost"
  );
  if (!explicitNatMap && !isLocalSentinel) {
    return undefined;
  }

  return (key: string) => {
    if (typeof explicitNatMap === "function") {
      const mapped = explicitNatMap(key);
      if (mapped) return mapped;
    } else if (explicitNatMap && typeof explicitNatMap === "object") {
      const mapped = explicitNatMap[key];
      if (mapped) return mapped;
    }

    if (isLocalSentinel) {
      if (key === "redis-master:6379") {
        return { host: "127.0.0.1", port: Number(process.env.REDIS_PORT || 6379) };
      }
      if (key === "redis-replica:6379") {
        return { host: "127.0.0.1", port: 6380 };
      }
    }
    return null;
  };
}

function buildClientFromConfig(
  cfg: RedisInstanceConfig,
  mode: "sentinel" | "cluster" | "standalone",
  forBlocking: boolean
): RedisClient {
  if (mode === "sentinel") {
    const sentinels = parseHostPortList(cfg.sentinels, 26379);
    const effectiveSentinels: HostPort[] =
      sentinels.length > 0 ? sentinels : [{ host: "127.0.0.1", port: 26379 }];
    const masterName = cfg.masterName?.trim() || "mymaster";
    const sentinelPassword = decryptIfEncrypted(cfg.sentinelPassword) || undefined;
    const role: "master" | "slave" = cfg.role === "slave" ? "slave" : "master";
    const natMap = buildEffectiveSentinelNatMap(
      effectiveSentinels,
      cfg.sentinelNatMap ?? cfg.natMap
    );

    return new Redis({
      ...buildBaseRedisOptions(cfg, forBlocking),
      sentinels: effectiveSentinels,
      name: masterName,
      role,
      sentinelPassword,
      ...(natMap ? { natMap } : {}),
      db: Number(cfg.db ?? 0),
      lazyConnect: !forBlocking,
      sentinelRetryStrategy: (times: number) => {
        if (!forBlocking && times > 3) return null;
        return Math.min(times * 200, 2_000);
      },
      retryStrategy: (times: number) => {
        if (!forBlocking && times > 3) return null;
        return Math.min(times * 200, 2_000);
      },
    });
  }

  if (mode === "cluster") {
    const nodes = parseHostPortList(cfg.clusterNodes, 7001);
    const effectiveNodes: ClusterNode[] =
      nodes.length > 0
        ? nodes
        : [{ host: cfg.host?.trim() || "127.0.0.1", port: Number(cfg.port || 7001) }];

    const options: ClusterOptions = {
      lazyConnect: !forBlocking,
      scaleReads: "master",
      enableReadyCheck: true,
      clusterRetryStrategy: (times: number) => {
        if (!forBlocking && times > 3) return null;
        return Math.min(times * 200, 2_000);
      },
      redisOptions: buildBaseRedisOptions(cfg, forBlocking),
      ...(cfg.natMap ? { natMap: cfg.natMap } : {}),
    };

    return new Cluster(effectiveNodes, options);
  }

  // Standalone
  const redisUrl = decryptConnectionUrl(cfg.url);
  const baseOptions: RedisOptions = {
    ...buildBaseRedisOptions(cfg, forBlocking),
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
    host: cfg.host?.trim() || "127.0.0.1",
    port: Number(cfg.port || 6379),
    db: Number(cfg.db ?? 0),
  });
}

function buildPrimaryConfigFromEnv(): RedisInstanceConfig {
  const modeEnv = process.env.REDIS_MODE?.trim().toLowerCase();
  const mode =
    modeEnv === "sentinel" || modeEnv === "cluster" || modeEnv === "standalone"
      ? modeEnv
      : undefined;
  const roleRaw = process.env.REDIS_SENTINEL_ROLE?.trim().toLowerCase();
  return {
    name: DEFAULT_REDIS_NAME,
    mode,
    sentinels: process.env.REDIS_SENTINELS,
    masterName: process.env.REDIS_SENTINEL_MASTER?.trim() || "mymaster",
    sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
    role: roleRaw === "slave" ? "slave" : "master",
    sentinelNatMap: parseNatMap(process.env.REDIS_SENTINEL_NAT_MAP),
    clusterNodes: process.env.REDIS_CLUSTER_NODES,
    natMap: parseNatMap(process.env.REDIS_CLUSTER_NAT_MAP),
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB || 0),
    keyPrefix: process.env.REDIS_KEY_PREFIX,
    allowFallback: process.env.REDIS_ALLOW_FALLBACK !== "false",
  };
}

function parseAdditionalInstancesFromEnv(): RedisInstanceConfig[] {
  const raw = process.env.REDIS_INSTANCES?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RedisInstanceConfig =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as RedisInstanceConfig).name === "string" &&
          (item as RedisInstanceConfig).name.trim().length > 0
      )
      .map((item) => ({
        ...item,
        name: item.name.trim(),
        allowFallback: item.allowFallback !== false,
      }));
  } catch (err) {
    log.warn({ err }, "Invalid REDIS_INSTANCES JSON; ignoring secondary Redis configs");
    return [];
  }
}

/**
 * Register and connect a named Redis instance (Sentinel, Cluster, or Standalone).
 * Can be called at startup or dynamically at runtime for cross-department Redis access.
 */
export async function registerRedisInstance(
  config: RedisInstanceConfig
): Promise<boolean> {
  const name = config.name.trim();
  if (!name) {
    throw new Error("Redis instance `name` is required");
  }

  const existing = instances.get(name);
  if (existing?.ready && existing.client) {
    return true;
  }

  const mode = resolveInstanceMode(config);
  const keyPrefix = normalizeKeyPrefix(config.keyPrefix);
  const client = buildClientFromConfig(config, mode, false);

  const entry: RedisInstanceEntry = {
    name,
    config,
    mode,
    keyPrefix,
    client: null,
    ready: false,
  };
  instances.set(name, entry);

  client.on("error", (err: Error) => {
    if (entry.ready) {
      log.warn({ err, name, mode }, "Redis connection warning");
    }
  });

  try {
    await client.connect();
    await client.ping();
    entry.client = client;
    entry.ready = true;
    log.info({ name, mode, keyPrefix }, `Redis instance "${name}" (${mode}) connected`);
    return true;
  } catch (err) {
    await client.quit().catch(() => client.disconnect());
    entry.client = null;
    entry.ready = false;
    entry.mode = "disabled";
    const msg = err instanceof Error ? err.message : String(err);

    if (config.allowFallback !== false) {
      log.warn(
        { name, mode, reason: msg },
        `Redis instance "${name}" unavailable; continuing without it`
      );
      return false;
    }

    log.error({ err, name, mode }, `Redis instance "${name}" connection failed`);
    throw new Error(`Redis "${name}" (${mode}) connection failed: ${msg}`);
  }
}

export function isRedisConnected(name: string = DEFAULT_REDIS_NAME): boolean {
  const entry = instances.get(name);
  return Boolean(entry?.ready && entry.client);
}

export function getRedisMode(name: string = DEFAULT_REDIS_NAME): RedisMode {
  return instances.get(name)?.mode ?? "disabled";
}

export function getRedisKeyPrefix(name: string = DEFAULT_REDIS_NAME): string {
  return (
    instances.get(name)?.keyPrefix ??
    normalizeKeyPrefix(process.env.REDIS_KEY_PREFIX)
  );
}

export function getRedisClient(name: string = DEFAULT_REDIS_NAME): RedisClient {
  const entry = instances.get(name);
  if (!entry?.ready || !entry.client) {
    throw new Error(`Redis client "${name}" is not initialized or unavailable`);
  }
  return entry.client;
}

export function listRedisInstances(): RedisInstanceStatus[] {
  return Array.from(instances.values()).map((entry) => ({
    name: entry.name,
    mode: entry.mode,
    connected: entry.ready && entry.client !== null,
    keyPrefix: entry.keyPrefix,
  }));
}

/**
 * Create a dedicated Redis connection for blocking commands (BLPOP, BullMQ Queue/Worker)
 * on the specified named Redis instance (defaults to "primary").
 */
export function createBlockingRedisClient(
  name: string = DEFAULT_REDIS_NAME
): RedisClient | null {
  const entry = instances.get(name);
  if (!entry?.ready || !entry.client || entry.mode === "disabled") return null;

  const client = buildClientFromConfig(entry.config, entry.mode, true);
  client.on("error", (err: Error) => {
    log.warn({ err, name, mode: entry.mode }, "Blocking Redis connection warning");
  });
  return client;
}

/**
 * Create a BullMQ-compatible Redis connection (`maxRetriesPerRequest: null`).
 */
export function createBullMQConnection(
  name: string = DEFAULT_REDIS_NAME
): RedisClient | null {
  return createBlockingRedisClient(name);
}

/**
 * Initialize the primary Redis instance and all secondary instances configured via `REDIS_INSTANCES`.
 */
export async function initRedis(): Promise<boolean> {
  if (process.env.REDIS_ENABLED === "false") {
    log.info("Redis disabled via REDIS_ENABLED=false");
    return false;
  }

  const primaryOk = await registerRedisInstance(buildPrimaryConfigFromEnv());

  const secondaryConfigs = parseAdditionalInstancesFromEnv();
  if (secondaryConfigs.length > 0) {
    await Promise.all(
      secondaryConfigs.map((cfg) => registerRedisInstance(cfg))
    );
  }

  return primaryOk;
}

export async function closeRedis(): Promise<void> {
  const closing = Array.from(instances.values()).map(async (entry) => {
    if (entry.client) {
      await entry.client.quit().catch(() => entry.client?.disconnect());
      entry.client = null;
      entry.ready = false;
      entry.mode = "disabled";
    }
  });
  await Promise.all(closing);
  instances.clear();
  log.info("All Redis connections closed");
}
