import crypto from "node:crypto";
import { queryDb } from "../db/database.js";
import type { UserMcpServer } from "../types/skill.js";

type DbMcpRow = {
  id: string;
  owner: string;
  name: string;
  transport: string;
  url: string;
  headers: Record<string, string> | string | null;
  description: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function normalizeOwner(owner: string | undefined): string {
  const cleaned = (owner ?? "").trim();
  if (!cleaned) {
    throw new Error("`owner` (creator) is required for MCP isolation");
  }
  return cleaned;
}

function parseHeaders(
  raw: Record<string, string> | string | null | undefined
): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapDbRowToMcp(row: DbMcpRow): UserMcpServer {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    transport: "streamable-http",
    url: row.url,
    headers: parseHeaders(row.headers),
    description: row.description ?? "",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listMcpServersByOwner(
  owner: string
): Promise<UserMcpServer[]> {
  const normalizedOwner = normalizeOwner(owner);
  const res = await queryDb<DbMcpRow>(
    `SELECT id, owner, name, transport, url, headers, description, created_at, updated_at
     FROM mcp_servers
     WHERE owner = $1
     ORDER BY updated_at DESC`,
    [normalizedOwner]
  );
  return res.rows.map(mapDbRowToMcp);
}

export async function getMcpServersByIdsForOwner(
  ids: string[],
  owner: string
): Promise<UserMcpServer[]> {
  const normalizedOwner = normalizeOwner(owner);
  if (!ids || ids.length === 0) return [];
  const all = await listMcpServersByOwner(normalizedOwner);
  const idSet = new Set(ids);
  return all.filter((m) => idSet.has(m.id));
}

export async function createOrUpdateMcpServer(input: {
  owner: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  description?: string;
}): Promise<UserMcpServer> {
  const owner = normalizeOwner(input.owner);
  const name = input.name.trim();
  const url = input.url.trim();
  const description = (input.description ?? "").trim();

  if (!name) {
    throw new Error("MCP `name` is required");
  }
  if (!url) {
    throw new Error("MCP Streamable HTTP `url` is required");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid MCP URL: "${url}"`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("MCP URL must start with http:// or https://");
  }

  const headers = parseHeaders(input.headers);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await queryDb(
    `INSERT INTO mcp_servers (
       id, owner, name, transport, url, headers, description, created_at, updated_at
     )
     VALUES ($1, $2, $3, 'streamable-http', $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (owner, name)
     DO UPDATE SET
       url = EXCLUDED.url,
       headers = EXCLUDED.headers,
       description = EXCLUDED.description,
       updated_at = EXCLUDED.updated_at`,
    [id, owner, name, url, JSON.stringify(headers), description, now, now]
  );

  const res = await queryDb<DbMcpRow>(
    `SELECT id, owner, name, transport, url, headers, description, created_at, updated_at
     FROM mcp_servers
     WHERE owner = $1 AND name = $2`,
    [owner, name]
  );
  return mapDbRowToMcp(res.rows[0]);
}

export async function deleteMcpServerForOwner(
  id: string,
  owner: string
): Promise<boolean> {
  const normalizedOwner = normalizeOwner(owner);
  const existing = await queryDb<{ id: string }>(
    `SELECT id FROM mcp_servers WHERE id = $1 AND owner = $2`,
    [id, normalizedOwner]
  );
  if (existing.rows.length === 0) return false;

  await queryDb(`DELETE FROM mcp_servers WHERE id = $1 AND owner = $2`, [
    id,
    normalizedOwner,
  ]);
  return true;
}
