import type http from "node:http";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  abortWorkbenchSession,
  closeWorkbenchSession,
  createWorkbenchSession,
  getWorkbenchSession,
  listWorkbenchSessions,
  sendWorkbenchMessage,
  setWorkbenchThinkingLevel,
} from "../services/workbenchService.js";

export async function listWorkbenchSessionsHandler(
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const owner = url.searchParams.get("owner")?.trim() || undefined;
  const sessions = listWorkbenchSessions(owner);
  sendJson(res, 200, { sessions });
}

export async function createWorkbenchSessionHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const owner =
    typeof body.owner === "string" && body.owner.trim()
      ? body.owner.trim()
      : "Admin";
  const repoId = typeof body.repoId === "string" ? body.repoId.trim() : undefined;
  const customCwd =
    typeof body.customCwd === "string" ? body.customCwd.trim() : undefined;
  const selectedMcps = Array.isArray(body.selectedMcps)
    ? body.selectedMcps.filter((item): item is string => typeof item === "string")
    : undefined;
  const thinkingLevel =
    typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : undefined;

  const rawOpenai =
    body.openaiConfig && typeof body.openaiConfig === "object"
      ? (body.openaiConfig as Record<string, unknown>)
      : undefined;
  const openaiConfig = rawOpenai
    ? {
        ...(typeof rawOpenai.apiKey === "string" && rawOpenai.apiKey.trim()
          ? { apiKey: rawOpenai.apiKey.trim() }
          : {}),
        ...(typeof rawOpenai.modelName === "string" && rawOpenai.modelName.trim()
          ? { modelName: rawOpenai.modelName.trim() }
          : {}),
        ...(typeof rawOpenai.baseUrl === "string" && rawOpenai.baseUrl.trim()
          ? { baseUrl: rawOpenai.baseUrl.trim() }
          : {}),
        ...(rawOpenai.apiMode === "chat" || rawOpenai.apiMode === "responses"
          ? { apiMode: rawOpenai.apiMode as "chat" | "responses" }
          : {}),
      }
    : undefined;

  const session = await createWorkbenchSession({
    owner,
    repoId,
    customCwd,
    selectedMcps,
    openaiConfig,
    thinkingLevel,
  });
  sendJson(res, 201, { session });
}

export async function getWorkbenchSessionHandler(
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const session = getWorkbenchSession(decodeURIComponent(rawId));
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}

export async function sendWorkbenchMessageHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const body = await readJsonBody(req);
  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) {
    return sendJson(res, 400, { error: "`message` is required" });
  }
  const session = sendWorkbenchMessage(decodeURIComponent(rawId), message);
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 202, { session });
}

export async function abortWorkbenchSessionHandler(
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const session = await abortWorkbenchSession(decodeURIComponent(rawId));
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}

export async function closeWorkbenchSessionHandler(
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const ok = await closeWorkbenchSession(decodeURIComponent(rawId));
  if (!ok) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { ok: true });
}

export async function setWorkbenchThinkingHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const body = await readJsonBody(req);
  const thinkingLevel =
    typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() : "";
  if (!thinkingLevel) {
    return sendJson(res, 400, { error: "`thinkingLevel` is required" });
  }
  const session = setWorkbenchThinkingLevel(
    decodeURIComponent(rawId),
    thinkingLevel
  );
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}
