import type http from "node:http";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  MailTestSchema,
  OAuthLoginSchema,
  parseWithSchema,
} from "../schemas/apiSchemas.js";
import {
  buildOAuthAuthorizeConfig,
  exchangeOAuthCodeAndStoreInRedis,
  extractTokenFromRequest,
  logoutTokenFromRedis,
  verifyTokenFromRedis,
} from "../services/authService.js";
import { sendAlertEmail } from "../services/mailService.js";

/**
 * GET /api/auth/me
 * Strict Redis-backed token verification:
 * - Missing token / Redis unavailable / key missing / parse failure => 401
 * - Key exists in Redis AND parses cleanly => 200 { authenticated: true, user }
 */
export async function getAuthMeHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const token = extractTokenFromRequest(req, url);
  const result = await verifyTokenFromRedis(token);
  if (!result.authenticated) {
    return sendJson(res, 401, {
      authenticated: false,
      error: result.reason,
    });
  }

  return sendJson(res, 200, {
    authenticated: true,
    user: result.user,
  });
}

/**
 * GET /api/auth/oauth/url
 * Returns third-party OAuth authorize URL configuration for frontend redirect.
 */
export async function getOAuthAuthorizeUrlHandler(
  res: http.ServerResponse
): Promise<void> {
  const cfg = buildOAuthAuthorizeConfig();
  return sendJson(res, 200, cfg);
}

/**
 * POST /api/auth/oauth/login
 * Accepts either:
 * - `{ token }`: looks up token in Redis and parses session payload (401 if missing/invalid)
 * - `{ code, redirectUri? }`: exchanges OAuth2 authorization code and stores session in Redis
 */
export async function oauthLoginHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const rawBody = await readJsonBody(req);
  const parsed = parseWithSchema(OAuthLoginSchema, rawBody);
  if (!parsed.ok) {
    return sendJson(res, 400, {
      error: parsed.error,
      issues: parsed.issues,
    });
  }

  if (parsed.data.token) {
    const result = await verifyTokenFromRedis(parsed.data.token);
    if (!result.authenticated) {
      return sendJson(res, 401, {
        authenticated: false,
        error: result.reason,
      });
    }
    return sendJson(res, 200, {
      authenticated: true,
      token: result.token,
      user: result.user,
    });
  }

  try {
    const session = await exchangeOAuthCodeAndStoreInRedis({
      code: parsed.data.code!,
      redirectUri: parsed.data.redirectUri,
    });
    return sendJson(res, 200, {
      authenticated: true,
      token: session.token,
      user: session.user,
    });
  } catch (err) {
    return sendJson(res, 401, {
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /api/auth/logout
 */
export async function logoutHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const token = extractTokenFromRequest(req, url);
  await logoutTokenFromRedis(token);
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/alerts/mail/test
 * Test SMTP alert email delivery (validated via Zod).
 */
export async function testAlertMailHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const rawBody = await readJsonBody(req);
  const parsed = parseWithSchema(MailTestSchema, rawBody);
  if (!parsed.ok) {
    return sendJson(res, 400, {
      error: parsed.error,
      issues: parsed.issues,
    });
  }

  const out = await sendAlertEmail({
    to: parsed.data.to,
    subject: parsed.data.subject || "[AI-Pipeline] SMTP 告警邮件测试",
    text:
      parsed.data.text ||
      `这是一封来自 AI-Pipeline 的 SMTP 测试邮件 (${new Date().toISOString()})。`,
  });

  if (!out.sent) {
    return sendJson(res, 400, { ok: false, error: out.reason || "Mail not sent" });
  }
  return sendJson(res, 200, { ok: true, messageId: out.messageId });
}
