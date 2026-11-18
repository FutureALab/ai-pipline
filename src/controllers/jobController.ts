import type http from "node:http";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import {
  abortGenerationJob,
  getGenerationJob,
  restartGenerationJob,
  startGenerationJob,
} from "../services/generationJobService.js";

export async function startGenerationJobHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const skillName =
    typeof body.skillName === "string" ? body.skillName : undefined;
  const description =
    typeof body.description === "string" ? body.description : undefined;
  const creator =
    typeof body.creator === "string" && body.creator.trim()
      ? body.creator.trim()
      : "Admin";
  const selectedMcps = Array.isArray(body.selectedMcps)
    ? body.selectedMcps.filter((item): item is string => typeof item === "string")
    : undefined;
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
  const timeoutMs =
    typeof body.timeoutMs === "number"
      ? body.timeoutMs
      : body.timeoutMs === null
        ? 0
        : undefined;

  if (!prompt.trim()) {
    return sendJson(res, 400, { error: "`prompt` is required" });
  }

  const job = startGenerationJob({
    prompt,
    skillName,
    description,
    creator,
    selectedMcps,
    openaiConfig,
    timeoutMs,
  });
  sendJson(res, 202, { job });
}

export async function getGenerationJobHandler(
  res: http.ServerResponse,
  rawJobId: string
): Promise<void> {
  const jobId = decodeURIComponent(rawJobId);
  const job = getGenerationJob(jobId);
  if (!job) {
    return sendJson(res, 404, { error: `Job "${jobId}" not found` });
  }
  sendJson(res, 200, { job });
}

export async function abortGenerationJobHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawJobId: string
): Promise<void> {
  const jobId = decodeURIComponent(rawJobId);
  const body = await readJsonBody(req);
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : undefined;
  const job = await abortGenerationJob(jobId, reason);
  if (!job) {
    return sendJson(res, 404, { error: `Job "${jobId}" not found` });
  }
  sendJson(res, 200, { job });
}

export async function restartGenerationJobHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawJobId: string
): Promise<void> {
  const jobId = decodeURIComponent(rawJobId);
  const body = await readJsonBody(req);
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt
      : undefined;
  const timeoutMs =
    typeof body.timeoutMs === "number"
      ? body.timeoutMs
      : body.timeoutMs === null
        ? 0
        : undefined;

  const job = await restartGenerationJob(jobId, {
    ...(prompt ? { prompt } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  if (!job) {
    return sendJson(res, 404, { error: `Job "${jobId}" not found` });
  }
  sendJson(res, 202, { job });
}
