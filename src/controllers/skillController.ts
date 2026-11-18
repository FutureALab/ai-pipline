import type http from "node:http";
import {
  buildSkillZipBuffer,
  getSkillCard,
  listSkillCards,
  listSkillFiles,
  readSkillMarkdown,
  upsertSkillCard,
  writeSkillFile,
} from "../repositories/skillRepository.js";
import { normalizeSkillName } from "../repositories/skillStorage.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import { generateSkillFromPrompt } from "../services/skillGenerator.js";
import { runSkillInRepo } from "../services/skillRunner.js";

export async function listSkillsHandler(res: http.ServerResponse): Promise<void> {
  const skills = await listSkillCards();
  sendJson(res, 200, { skills });
}

export async function getSkillDetailHandler(
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = decodeURIComponent(rawName);
  const detail = await getSkillCard(name);
  if (!detail) {
    return sendJson(res, 404, { error: `Skill "${name}" not found` });
  }
  const files = await listSkillFiles(name);
  sendJson(res, 200, { ...detail, files });
}

export async function updateSkillHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = normalizeSkillName(decodeURIComponent(rawName));
  const body = await readJsonBody(req);
  const content = typeof body.content === "string" ? body.content : undefined;
  const filePath =
    typeof body.filePath === "string" && body.filePath.trim()
      ? body.filePath.trim()
      : "SKILL.md";
  const filesPayload = Array.isArray(body.files)
    ? (body.files as Array<{ path?: unknown; content?: unknown }>)
    : undefined;
  const description =
    typeof body.description === "string" ? body.description : undefined;
  const creator = typeof body.creator === "string" ? body.creator : undefined;
  const submit = body.submit === true;

  if (filesPayload) {
    for (const item of filesPayload) {
      if (typeof item.path === "string" && typeof item.content === "string") {
        await writeSkillFile(name, item.path, item.content);
      }
    }
  } else if (content !== undefined) {
    await writeSkillFile(name, filePath, content);
  }

  const card = await upsertSkillCard(name, {
    ...(description !== undefined ? { description } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(submit ? { currentStep: 3, progress: 66, status: "submitted" } : {}),
  });

  const savedContent = await readSkillMarkdown(name).catch(() => "");
  const files = await listSkillFiles(name);
  sendJson(res, 200, { card, content: savedContent, files });
}

export async function downloadSkillHandler(
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = normalizeSkillName(decodeURIComponent(rawName));
  const detail = await getSkillCard(name);
  if (!detail) {
    return sendJson(res, 404, { error: `Skill "${name}" not found` });
  }
  const zipBuf = await buildSkillZipBuffer(name);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zipBuf.length,
    "Content-Disposition": `attachment; filename="${name}.zip"`,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(zipBuf);
}

export async function generateSkillSyncHandler(
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

  if (!prompt.trim()) {
    return sendJson(res, 400, { error: "`prompt` is required" });
  }

  const result = await generateSkillFromPrompt({
    userPrompt: description
      ? `Skill description: ${description}\n\n${prompt}`
      : prompt,
    skillName,
    scope: "global",
  });

  const card = await upsertSkillCard(result.saved.skillName, {
    description: description || prompt.slice(0, 120),
    creator,
    currentStep: 1,
    progress: 33,
    status: "draft",
  });

  const files = await listSkillFiles(result.saved.skillName);

  sendJson(res, 201, {
    card,
    skillName: result.saved.skillName,
    filePath: result.saved.filePath,
    content: result.content,
    files,
    modelFallbackMessage: result.modelFallbackMessage,
  });
}

export async function runSkillHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const skillName = typeof body.skillName === "string" ? body.skillName : "";
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const taskPrompt =
    typeof body.taskPrompt === "string" ? body.taskPrompt : undefined;

  if (!skillName.trim() || !cwd.trim()) {
    return sendJson(res, 400, { error: "`skillName` and `cwd` are required" });
  }

  const result = await runSkillInRepo({
    skillName,
    cwd,
    taskPrompt,
  });
  sendJson(res, 200, result);
}
