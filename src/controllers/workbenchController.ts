import type http from "node:http";
import { fetchOpenAIAvailableModels } from "../config/envModel.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  abortWorkbenchSession,
  addWorkbenchUserTodo,
  closeWorkbenchSession,
  createWorkbenchSession,
  getWorkbenchSession,
  listWorkbenchExtensions,
  listWorkbenchSessions,
  removeWorkbenchTodo,
  sendWorkbenchMessage,
  setWorkbenchThinkingLevel,
  stopWorkbenchBackgroundCommand,
  submitWorkbenchQuestionAnswer,
} from "../services/workbenchService.js";
import type { UserQuestionAnswerItem } from "../workbench/types.js";

export async function listOpenAIModelsHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : undefined;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
  const apiMode =
    body.apiMode === "responses" || body.apiMode === "chat"
      ? (body.apiMode as "chat" | "responses")
      : undefined;

  try {
    const result = await fetchOpenAIAvailableModels({
      baseUrl,
      apiKey,
      apiMode,
    });
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}

export async function listWorkbenchExtensionsHandler(
  res: http.ServerResponse
): Promise<void> {
  const extensions = listWorkbenchExtensions();
  sendJson(res, 200, { extensions });
}

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
  const disabledExtensions = Array.isArray(body.disabledExtensions)
    ? body.disabledExtensions.filter(
        (item): item is string => typeof item === "string"
      )
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
    disabledExtensions,
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

export async function submitWorkbenchQuestionAnswerHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const body = await readJsonBody(req);
  const toolCallId =
    typeof body.toolCallId === "string" ? body.toolCallId.trim() : "";
  const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
  const answers: UserQuestionAnswerItem[] = rawAnswers
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      questionId: String(item.questionId ?? "").trim(),
      selectedLabels: Array.isArray(item.selectedLabels)
        ? item.selectedLabels.filter((s): s is string => typeof s === "string")
        : [],
      ...(typeof item.otherText === "string" && item.otherText.trim()
        ? { otherText: item.otherText.trim() }
        : {}),
      ...(item.discussFirst ? { discussFirst: true } : {}),
      ...(typeof item.discussNote === "string" && item.discussNote.trim()
        ? { discussNote: item.discussNote.trim() }
        : {}),
    }));

  const session = submitWorkbenchQuestionAnswer(decodeURIComponent(rawId), {
    toolCallId,
    answers,
    cancelled: Boolean(body.cancelled),
    chatInstead: Boolean(body.chatInstead),
  });
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}

export async function addWorkbenchTodoHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string
): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return sendJson(res, 400, { error: "`title` is required" });
  }
  const group =
    typeof body.group === "string" && body.group.trim()
      ? body.group.trim()
      : undefined;
  const session = addWorkbenchUserTodo(decodeURIComponent(rawId), title, group);
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 201, { session });
}

export async function removeWorkbenchTodoHandler(
  res: http.ServerResponse,
  rawId: string,
  rawItemId: string
): Promise<void> {
  const session = removeWorkbenchTodo(
    decodeURIComponent(rawId),
    decodeURIComponent(rawItemId)
  );
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}

export async function stopWorkbenchBgCommandHandler(
  res: http.ServerResponse,
  rawId: string,
  rawCmdId: string
): Promise<void> {
  const session = stopWorkbenchBackgroundCommand(
    decodeURIComponent(rawId),
    decodeURIComponent(rawCmdId)
  );
  if (!session) {
    return sendJson(res, 404, { error: "Workbench session not found" });
  }
  sendJson(res, 200, { session });
}
