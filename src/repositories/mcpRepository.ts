import crypto from "node:crypto";
import {
  decryptRecordValues,
  encryptRecordValues,
} from "../config/crypto.js";
import {
  getDb,
  getPrismaOrNull,
  isMysqlDriver,
  toDbTimestamp,
} from "../db/database.js";
import type { McpServerRow } from "../db/schema.js";
import type {
  McpServer as PrismaMcpServer,
  Prisma,
} from "../generated/prisma/client.js";
import type { UserMcpServer } from "../types/skill.js";

function normalizeOwner(owner: string | undefined): string {
  const cleaned = (owner ?? "").trim();
  if (!cleaned) {
    throw new Error("`owner` (creator) is required for MCP isolation");
  }
  return cleaned;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
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

function mapPrismaMcp(row: PrismaMcpServer): UserMcpServer {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    transport: "streamable-http",
    url: row.url,
    headers: decryptRecordValues(parseHeaders(row.headers)),
    description: row.description ?? "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapDbRowToMcp(row: McpServerRow): UserMcpServer {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    transport: "streamable-http",
    url: row.url,
    headers: decryptRecordValues(parseHeaders(row.headers)),
    description: row.description ?? "",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listMcpServersByOwner(
  owner: string
): Promise<UserMcpServer[]> {
  const normalizedOwner = normalizeOwner(owner);
  const prisma = getPrismaOrNull();
  if (prisma) {
    const rows = await prisma.mcpServer.findMany({
      where: { owner: normalizedOwner },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(mapPrismaMcp);
  }

  const rows = await getDb()
    .selectFrom("mcp_servers")
    .select([
      "id",
      "owner",
      "name",
      "transport",
      "url",
      "headers",
      "description",
      "created_at",
      "updated_at",
    ])
    .where("owner", "=", normalizedOwner)
    .orderBy("updated_at", "desc")
    .execute();
  return rows.map(mapDbRowToMcp);
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
  const encryptedHeaders = encryptRecordValues(headers);
  const id = crypto.randomUUID();
  const prisma = getPrismaOrNull();

  if (prisma) {
    const now = new Date();
    const row = await prisma.mcpServer.upsert({
      where: { owner_name: { owner, name } },
      create: {
        id,
        owner,
        name,
        transport: "streamable-http",
        url,
        headers: encryptedHeaders as unknown as Prisma.InputJsonValue,
        description,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        url,
        headers: encryptedHeaders as unknown as Prisma.InputJsonValue,
        description,
        updatedAt: now,
      },
    });
    return mapPrismaMcp(row);
  }

  const now = toDbTimestamp(new Date().toISOString());
  const db = getDb();
  const values = {
    id,
    owner,
    name,
    transport: "streamable-http",
    url,
    headers: JSON.stringify(encryptedHeaders),
    description,
    created_at: now,
    updated_at: now,
  };
  const update = {
    url,
    headers: JSON.stringify(encryptedHeaders),
    description,
    updated_at: now,
  };

  if (isMysqlDriver()) {
    await db
      .insertInto("mcp_servers")
      .values(values)
      .onDuplicateKeyUpdate(update)
      .execute();
  } else {
    await db
      .insertInto("mcp_servers")
      .values(values)
      .onConflict((oc) => oc.columns(["owner", "name"]).doUpdateSet(update))
      .execute();
  }

  const row = await db
    .selectFrom("mcp_servers")
    .select([
      "id",
      "owner",
      "name",
      "transport",
      "url",
      "headers",
      "description",
      "created_at",
      "updated_at",
    ])
    .where("owner", "=", owner)
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
  return mapDbRowToMcp(row);
}

export async function deleteMcpServerForOwner(
  id: string,
  owner: string
): Promise<boolean> {
  const normalizedOwner = normalizeOwner(owner);
  const prisma = getPrismaOrNull();
  if (prisma) {
    const res = await prisma.mcpServer.deleteMany({
      where: { id, owner: normalizedOwner },
    });
    return res.count > 0;
  }

  const db = getDb();
  const existing = await db
    .selectFrom("mcp_servers")
    .select("id")
    .where("id", "=", id)
    .where("owner", "=", normalizedOwner)
    .executeTakeFirst();
  if (!existing) return false;

  await db
    .deleteFrom("mcp_servers")
    .where("id", "=", id)
    .where("owner", "=", normalizedOwner)
    .execute();
  return true;
}
