import crypto from "node:crypto";
import type http from "node:http";
import { decodeJwt, jwtVerify } from "jose";
import { decryptIfEncrypted } from "../config/crypto.js";
import { createLogger } from "../config/logger.js";
import {
  DEFAULT_REDIS_NAME,
  getRedisClient,
  isRedisConnected,
} from "../db/redis.js";
import {
  RedisSessionUserSchema,
  type RedisSessionUser,
} from "../schemas/apiSchemas.js";

const authLog = createLogger("auth");

export type AuthVerificationResult =
  | { authenticated: true; token: string; user: RedisSessionUser }
  | { authenticated: false; reason: string };

function getAuthRedisInstanceName(): string {
  return process.env.AUTH_REDIS_INSTANCE?.trim() || DEFAULT_REDIS_NAME;
}

function getAuthRedisPrefix(): string {
  return process.env.AUTH_REDIS_KEY_PREFIX ?? "auth:token:";
}

function getSessionTtlSeconds(): number {
  const raw = Number(process.env.AUTH_SESSION_TTL_SECONDS || 86400);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 86400;
}

export function extractTokenFromRequest(
  req: http.IncomingMessage,
  url?: URL
): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.trim()) {
    const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
    return authHeader.trim();
  }

  const xAuth = req.headers["x-auth-token"];
  if (typeof xAuth === "string" && xAuth.trim()) {
    return xAuth.trim();
  }

  const queryToken = url?.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }

  return null;
}

function normalizeRawSessionObject(obj: Record<string, unknown>): Record<string, unknown> {
  const userId = obj.userId ?? obj.user_id ?? obj.id ?? obj.sub;
  const username =
    obj.username ??
    obj.user_name ??
    obj.preferred_username ??
    obj.login ??
    obj.name ??
    (typeof obj.email === "string" ? obj.email.split("@")[0] : undefined);
  const roles = Array.isArray(obj.roles)
    ? obj.roles.map(String)
    : typeof obj.role === "string"
      ? [obj.role]
      : [];

  let expiresAt: number | undefined;
  if (typeof obj.expiresAt === "number") {
    expiresAt = obj.expiresAt;
  } else if (typeof obj.exp === "number") {
    expiresAt = obj.exp < 10_000_000_000 ? obj.exp * 1000 : obj.exp;
  }

  return {
    userId,
    username,
    nickname: typeof obj.nickname === "string" ? obj.nickname : typeof obj.name === "string" ? obj.name : undefined,
    email: typeof obj.email === "string" ? obj.email : undefined,
    avatar: typeof obj.avatar === "string" ? obj.avatar : typeof obj.picture === "string" ? obj.picture : undefined,
    roles,
    provider: typeof obj.provider === "string" ? obj.provider : "oauth",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * Parse a raw value fetched from Redis into a validated `RedisSessionUser`.
 * Supports JSON objects, Jasypt `ENC(...)` encrypted JSON/JWT, and JWT strings (via `jose`).
 */
export async function parseRedisSessionPayload(
  rawValue: string
): Promise<{ ok: true; user: RedisSessionUser } | { ok: false; reason: string }> {
  let plain: string;
  try {
    plain = decryptIfEncrypted(rawValue);
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to decrypt Redis session payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsedObj: Record<string, unknown> | null = null;

  // 1. Check if payload is a JWT (3 dot-separated segments)
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(plain)) {
    try {
      const jwtSecret = decryptIfEncrypted(process.env.AUTH_JWT_SECRET);
      if (jwtSecret) {
        const verified = await jwtVerify(
          plain,
          new TextEncoder().encode(jwtSecret)
        );
        parsedObj = verified.payload as Record<string, unknown>;
      } else {
        parsedObj = decodeJwt(plain) as Record<string, unknown>;
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Invalid JWT stored in Redis: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    // 2. Parse JSON object
    try {
      const parsed = JSON.parse(plain) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "Redis session payload is not a JSON object" };
      }
      parsedObj = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "Redis session payload is not valid JSON" };
    }
  }

  const normalized = normalizeRawSessionObject(parsedObj);
  const validated = RedisSessionUserSchema.safeParse(normalized);
  if (!validated.success) {
    return {
      ok: false,
      reason: `Redis session payload schema mismatch: ${validated.error.issues[0]?.message ?? "invalid fields"}`,
    };
  }

  if (validated.data.expiresAt && validated.data.expiresAt <= Date.now()) {
    return { ok: false, reason: "Session token has expired" };
  }

  return { ok: true, user: validated.data };
}

/**
 * Verify an OAuth/session token strictly against Redis:
 * 1. Read token data from Redis (prefixed key first, then raw token key).
 * 2. If Redis is unavailable or key is missing -> return unauthenticated.
 * 3. Parse & validate payload -> only succeed when parsing succeeds.
 */
export async function verifyTokenFromRedis(
  token: string | null | undefined
): Promise<AuthVerificationResult> {
  const cleanToken = token?.trim();
  if (!cleanToken) {
    return { authenticated: false, reason: "Missing authentication token" };
  }

  const redisInstance = getAuthRedisInstanceName();
  if (!isRedisConnected(redisInstance)) {
    return {
      authenticated: false,
      reason: `Redis instance "${redisInstance}" is unavailable; cannot verify authentication token`,
    };
  }

  const redis = getRedisClient(redisInstance);
  const prefixedKey = `${getAuthRedisPrefix()}${cleanToken}`;
  let rawValue: string | null = null;

  try {
    rawValue = await redis.get(prefixedKey);
    if (rawValue === null && prefixedKey !== cleanToken) {
      rawValue = await redis.get(cleanToken);
    }
  } catch (err) {
    authLog.warn({ err }, "Failed to read auth token from Redis");
    return {
      authenticated: false,
      reason: "Failed to read authentication state from Redis",
    };
  }

  if (rawValue === null || !rawValue.trim()) {
    return {
      authenticated: false,
      reason: "Token not found in Redis (unauthenticated)",
    };
  }

  const parsed = await parseRedisSessionPayload(rawValue);
  if (!parsed.ok) {
    return { authenticated: false, reason: parsed.reason };
  }

  return {
    authenticated: true,
    token: cleanToken,
    user: parsed.user,
  };
}

export function buildOAuthAuthorizeConfig(): {
  configured: boolean;
  providerName: string;
  authorizeUrl: string | null;
  state: string;
} {
  const base = process.env.OAUTH_AUTHORIZE_URL?.trim();
  const clientId = process.env.OAUTH_CLIENT_ID?.trim();
  const redirectUri = process.env.OAUTH_REDIRECT_URI?.trim();
  const scope = process.env.OAUTH_SCOPE?.trim() || "openid profile email";
  const providerName = process.env.OAUTH_PROVIDER_NAME?.trim() || "OAuth2 SSO";
  const state = crypto.randomBytes(16).toString("hex");

  if (!base || !clientId) {
    return {
      configured: false,
      providerName,
      authorizeUrl: null,
      state,
    };
  }

  const url = new URL(base);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);

  return {
    configured: true,
    providerName,
    authorizeUrl: url.toString(),
    state,
  };
}

/**
 * Exchange an OAuth2 authorization `code` with the configured 3rd-party OAuth provider,
 * persist the resulting session in Redis, and return `{ token, user }`.
 */
export async function exchangeOAuthCodeAndStoreInRedis(params: {
  code: string;
  redirectUri?: string;
}): Promise<{ token: string; user: RedisSessionUser }> {
  const tokenUrl = process.env.OAUTH_TOKEN_URL?.trim();
  const clientId = process.env.OAUTH_CLIENT_ID?.trim();
  const clientSecret = decryptIfEncrypted(process.env.OAUTH_CLIENT_SECRET);
  const redirectUri =
    params.redirectUri?.trim() || process.env.OAUTH_REDIRECT_URI?.trim() || "";

  if (!tokenUrl || !clientId) {
    throw new Error(
      "OAuth2 provider is not configured (OAUTH_TOKEN_URL / OAUTH_CLIENT_ID missing)"
    );
  }

  const redisInstance = getAuthRedisInstanceName();
  if (!isRedisConnected(redisInstance)) {
    throw new Error(
      `Redis instance "${redisInstance}" is unavailable; cannot persist OAuth session`
    );
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  });

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (HTTP ${tokenRes.status}): ${body.slice(0, 200)}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  const accessToken = tokenData.access_token?.trim();
  if (!accessToken) {
    throw new Error("OAuth provider did not return an access_token");
  }

  let profileObj: Record<string, unknown> = {};
  const userinfoUrl = process.env.OAUTH_USERINFO_URL?.trim();
  if (userinfoUrl) {
    const infoRes = await fetch(userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!infoRes.ok) {
      throw new Error(`OAuth userinfo fetch failed (HTTP ${infoRes.status})`);
    }
    profileObj = (await infoRes.json()) as Record<string, unknown>;
  } else if (tokenData.id_token) {
    profileObj = decodeJwt(tokenData.id_token) as Record<string, unknown>;
  }

  const ttlSeconds = tokenData.expires_in && tokenData.expires_in > 0
    ? Math.floor(tokenData.expires_in)
    : getSessionTtlSeconds();

  const normalized = normalizeRawSessionObject({
    ...profileObj,
    provider: process.env.OAUTH_PROVIDER_NAME?.trim() || "oauth",
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  const validated = RedisSessionUserSchema.parse(normalized);

  const redis = getRedisClient(redisInstance);
  const key = `${getAuthRedisPrefix()}${accessToken}`;
  await redis.set(key, JSON.stringify(validated), "EX", ttlSeconds);

  return { token: accessToken, user: validated };
}

export async function logoutTokenFromRedis(token: string | null): Promise<void> {
  const redisInstance = getAuthRedisInstanceName();
  if (!token?.trim() || !isRedisConnected(redisInstance)) return;
  const clean = token.trim();
  const redis = getRedisClient(redisInstance);
  const prefixedKey = `${getAuthRedisPrefix()}${clean}`;
  await redis.del(prefixedKey).catch(() => {});
  if (prefixedKey !== clean) {
    await redis.del(clean).catch(() => {});
  }
}
