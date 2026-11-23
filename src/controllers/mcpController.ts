import type http from "node:http";
import {
  createOrUpdateMcpServer,
  deleteMcpServerForOwner,
  listMcpServersByOwner,
} from "../repositories/mcpRepository.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import { CreateMcpSchema, parseWithSchema } from "../schemas/apiSchemas.js";

export async function listMcpsHandler(
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const owner = url.searchParams.get("owner")?.trim() || "";
  if (!owner) {
    return sendJson(res, 400, { error: "`owner` query parameter is required" });
  }
  const mcps = await listMcpServersByOwner(owner);
  sendJson(res, 200, { mcps });
}

export async function createMcpHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  let normalizedHeaders = body.headers;
  if (typeof body.headers === "string" && body.headers.trim()) {
    try {
      normalizedHeaders = JSON.parse(body.headers);
    } catch {
      return sendJson(res, 400, { error: "`headers` must be valid JSON object" });
    }
  } else if (typeof body.headers === "string") {
    normalizedHeaders = {};
  }

  const parsed = parseWithSchema(CreateMcpSchema, {
    ...body,
    headers: normalizedHeaders,
  });
  if (!parsed.ok) {
    return sendJson(res, 400, {
      error: parsed.error,
      issues: parsed.issues,
    });
  }

  const mcp = await createOrUpdateMcpServer(parsed.data);
  sendJson(res, 201, { mcp });
}

export async function deleteMcpHandler(
  res: http.ServerResponse,
  rawId: string,
  url: URL
): Promise<void> {
  const id = decodeURIComponent(rawId);
  const owner = url.searchParams.get("owner")?.trim() || "";
  if (!owner) {
    return sendJson(res, 400, { error: "`owner` query parameter is required" });
  }
  const deleted = await deleteMcpServerForOwner(id, owner);
  if (!deleted) {
    return sendJson(res, 404, {
      error: `MCP "${id}" not found for owner "${owner}"`,
    });
  }
  sendJson(res, 200, { ok: true });
}
