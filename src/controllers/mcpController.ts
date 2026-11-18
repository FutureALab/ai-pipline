import type http from "node:http";
import {
  createOrUpdateMcpServer,
  deleteMcpServerForOwner,
  listMcpServersByOwner,
} from "../repositories/mcpRepository.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";

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
  const owner = typeof body.owner === "string" ? body.owner.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";

  let headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  } else if (typeof body.headers === "string" && body.headers.trim()) {
    try {
      const parsed = JSON.parse(body.headers);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v;
        }
      }
    } catch {
      return sendJson(res, 400, { error: "`headers` must be valid JSON object" });
    }
  }

  if (!owner || !name || !url) {
    return sendJson(res, 400, {
      error: "`owner`, `name`, and Streamable HTTP `url` are required",
    });
  }

  const mcp = await createOrUpdateMcpServer({
    owner,
    name,
    url,
    headers,
    description,
  });
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
