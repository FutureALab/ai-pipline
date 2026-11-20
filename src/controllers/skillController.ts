import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getMcpServersByIdsForOwner } from "../repositories/mcpRepository.js";
import {
  buildSkillZipBuffer,
  deleteSkillCompletely,
  deleteSkillFile,
  getSkillCard,
  listSkillCards,
  listSkillFiles,
  readSkillMarkdown,
  replaceSkillFiles,
  upsertSkillCard,
  writeSkillFile,
} from "../repositories/skillRepository.js";
import {
  buildResourceSummary,
  enrichSkillFileEntry,
  extractDescriptionFromMarkdown,
  normalizeRelativeSkillPath,
  normalizeSkillName,
  parseSkillFrontmatter,
  readSkillDirectoryFiles,
  saveSkillFilesToDefaultDir,
} from "../repositories/skillStorage.js";
import { readJsonBody, sendJson } from "../routes/httpUtils.js";
import { generateSkillFromPrompt } from "../services/skillGenerator.js";
import {
  executeBatchDirectSkillsJenkinsRuns,
  executeDirectSkillJenkinsRuns,
} from "../services/pipelineService.js";
import { runSkillInRepo } from "../services/skillRunner.js";
import type { SkillFileEncoding, SkillFileEntry } from "../types/skill.js";

const execFileAsync = promisify(execFile);

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
  const encoding: SkillFileEncoding =
    body.encoding === "base64" ? "base64" : "utf-8";
  const filesPayload = Array.isArray(body.files)
    ? (body.files as Array<{ path?: unknown; content?: unknown; encoding?: unknown }>)
    : undefined;
  const replaceFiles = body.replaceFiles === true;
  const deleteFile =
    typeof body.deleteFile === "string" && body.deleteFile.trim()
      ? body.deleteFile.trim()
      : undefined;
  const description =
    typeof body.description === "string" ? body.description : undefined;
  const creator = typeof body.creator === "string" ? body.creator : undefined;
  const selectedMcps = Array.isArray(body.selectedMcps)
    ? body.selectedMcps.filter((item): item is string => typeof item === "string")
    : undefined;
  const submit = body.submit === true;

  if (filesPayload) {
    const validFiles: SkillFileEntry[] = [];
    for (const item of filesPayload) {
      if (typeof item.path === "string" && typeof item.content === "string") {
        validFiles.push({
          path: item.path,
          content: item.content,
          encoding: item.encoding === "base64" ? "base64" : "utf-8",
        });
      }
    }
    if (replaceFiles) {
      await replaceSkillFiles(name, validFiles);
    } else {
      for (const item of validFiles) {
        await writeSkillFile(name, item.path, item.content, item.encoding);
      }
    }
  } else if (content !== undefined) {
    await writeSkillFile(name, filePath, content, encoding);
  }

  if (deleteFile) {
    await deleteSkillFile(name, deleteFile);
  }

  const card = await upsertSkillCard(name, {
    ...(description !== undefined ? { description } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(selectedMcps !== undefined ? { selectedMcps } : {}),
    ...(submit ? { currentStep: 3, progress: 66, status: "submitted" } : {}),
  });

  const savedContent = await readSkillMarkdown(name).catch(() => "");
  const files = await listSkillFiles(name);
  sendJson(res, 200, { card, content: savedContent, files });
}

export async function deleteSkillHandler(
  res: http.ServerResponse,
  rawName: string
): Promise<void> {
  const name = normalizeSkillName(decodeURIComponent(rawName));
  if (!name) {
    return sendJson(res, 400, { error: "Invalid skill name" });
  }
  const result = await deleteSkillCompletely(name);
  sendJson(res, 200, {
    ok: true,
    ...result,
  });
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
  const selectedMcps = Array.isArray(body.selectedMcps)
    ? body.selectedMcps.filter((item): item is string => typeof item === "string")
    : [];
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

  if (!prompt.trim()) {
    return sendJson(res, 400, { error: "`prompt` is required" });
  }

  const mcpServers = await getMcpServersByIdsForOwner(selectedMcps, creator);

  const result = await generateSkillFromPrompt({
    userPrompt: description
      ? `Skill description: ${description}\n\n${prompt}`
      : prompt,
    skillName,
    scope: "global",
    mcpServers,
    openaiConfig,
  });

  await replaceSkillFiles(result.saved.skillName, result.files);

  const card = await upsertSkillCard(result.saved.skillName, {
    description: description || prompt.slice(0, 120),
    creator,
    selectedMcps,
    currentStep: 1,
    progress: 33,
    status: "draft",
    frontmatter: result.frontmatter,
    hasScripts: result.hasScripts,
    resourceSummary: result.resourceSummary,
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
  const rawSkillName =
    typeof body.skillName === "string" ? body.skillName.trim() : "";
  const rawSkillNames = Array.isArray(body.skillNames)
    ? body.skillNames
        .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
        .map((x) => normalizeSkillName(x.trim()))
    : [];
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const taskPrompt =
    typeof body.taskPrompt === "string" ? body.taskPrompt : undefined;
  const apps = Array.isArray(body.apps)
    ? body.apps.filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
    : [];
  const repos = Array.isArray(body.repos)
    ? body.repos.filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
    : [];
  const waitForCompletion = body.waitForCompletion === true;

  // Multi-skill batch execution mode
  if (rawSkillNames.length > 0) {
    const uniqueNames = [...new Set(rawSkillNames)];
    if (apps.length === 0) {
      return sendJson(res, 400, { error: "请至少选择 1 个相关应用" });
    }
    if (repos.length === 0) {
      return sendJson(res, 400, { error: "请至少选择 1 个 Git 版本库" });
    }

    const unpublished: string[] = [];
    for (const name of uniqueNames) {
      const existing = await getSkillCard(name);
      if (!existing) {
        return sendJson(res, 404, { error: `Skill "${name}" 不存在` });
      }
      if (existing.card.status !== "published") {
        unpublished.push(name);
      }
    }
    if (unpublished.length > 0) {
      return sendJson(res, 400, {
        error: `以下 Skill 尚未发布，无法直接运行：${unpublished.join(", ")}`,
      });
    }

    const result = await executeBatchDirectSkillsJenkinsRuns({
      skillNames: uniqueNames,
      apps,
      repoIds: repos,
      taskPrompt,
    });
    return sendJson(res, 200, result);
  }

  if (!rawSkillName) {
    return sendJson(res, 400, { error: "`skillName` or `skillNames` is required" });
  }
  const skillName = normalizeSkillName(rawSkillName);

  // Batch Jenkins execution mode when apps & repos are passed from frontend
  if (apps.length > 0 || repos.length > 0 || !cwd) {
    const existing = await getSkillCard(skillName);
    if (!existing) {
      return sendJson(res, 404, { error: `Skill "${skillName}" 不存在` });
    }
    if (existing.card.status !== "published") {
      return sendJson(res, 400, {
        error: "只有已发布的 Skill 才能直接使用，请先完成测试并发布该 Skill",
      });
    }
    if (apps.length === 0) {
      return sendJson(res, 400, { error: "请至少选择 1 个相关应用" });
    }
    if (repos.length === 0) {
      return sendJson(res, 400, { error: "请至少选择 1 个 Git 版本库" });
    }

    const result = await executeDirectSkillJenkinsRuns({
      skillName,
      apps,
      repoIds: repos,
      taskPrompt,
      waitForCompletion,
    });
    return sendJson(res, 200, result);
  }

  const result = await runSkillInRepo({
    skillName,
    cwd,
    taskPrompt,
  });
  sendJson(res, 200, result);
}

function stripCommonTopFolder(
  files: Array<{ path: string; content: string; encoding: SkillFileEncoding }>
): Array<{ path: string; content: string; encoding: SkillFileEncoding }> {
  const cleaned = files.filter((f) => {
    const p = f.path.replace(/\\/g, "/");
    return (
      !p.startsWith("__MACOSX/") &&
      !p.split("/").some((seg) => seg === ".DS_Store" || seg === "__MACOSX")
    );
  });
  if (cleaned.length === 0) return [];
  if (cleaned.some((f) => f.path === "SKILL.md")) return cleaned;

  const firstSegs = new Set(
    cleaned.map((f) => f.path.split("/")[0]).filter(Boolean)
  );
  if (firstSegs.size === 1 && cleaned.every((f) => f.path.includes("/"))) {
    const prefix = `${[...firstSegs][0]}/`;
    const stripped = cleaned.map((f) => ({
      ...f,
      path: f.path.slice(prefix.length),
    }));
    if (stripped.some((f) => f.path === "SKILL.md")) {
      return stripped;
    }
  }
  return cleaned;
}

async function extractZipToSkillFiles(zipBuf: Buffer): Promise<SkillFileEntry[]> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-upload-"));
  const zipPath = path.join(tmpRoot, "upload.zip");
  const extractDir = path.join(tmpRoot, "extracted");
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(zipPath, zipBuf);

  try {
    try {
      await execFileAsync("unzip", ["-qq", "-o", zipPath, "-d", extractDir], {
        timeout: 20_000,
      });
    } catch {
      await execFileAsync(
        "python3",
        [
          "-c",
          "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
          zipPath,
          extractDir,
        ],
        { timeout: 20_000 }
      );
    }

    // Remove __MACOSX metadata folder if present
    await fs
      .rm(path.join(extractDir, "__MACOSX"), { recursive: true, force: true })
      .catch(() => {});

    // Unwrap single nested root directory if SKILL.md is inside it
    let scanDir = extractDir;
    const directSkillMd = await fs
      .stat(path.join(extractDir, "SKILL.md"))
      .then((s) => s.isFile())
      .catch(() => false);
    if (!directSkillMd) {
      const topEntries = (
        await fs.readdir(extractDir, { withFileTypes: true })
      ).filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX");
      if (topEntries.length === 1 && topEntries[0].isDirectory()) {
        scanDir = path.join(extractDir, topEntries[0].name);
      }
    }

    return await readSkillDirectoryFiles(scanDir);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function uploadSkillHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req);
  const rawSkillName =
    typeof body.skillName === "string" ? body.skillName.trim() : "";
  const rawDescription =
    typeof body.description === "string" ? body.description.trim() : "";
  const creator =
    typeof body.creator === "string" && body.creator.trim()
      ? body.creator.trim()
      : "Admin";
  const fileName =
    typeof body.fileName === "string" ? body.fileName.trim() : "";
  const zipBase64 =
    typeof body.zipBase64 === "string" ? body.zipBase64.trim() : "";

  let entries: SkillFileEntry[] = [];

  if (zipBase64) {
    const cleanB64 = zipBase64.replace(/^data:[^;]+;base64,/, "");
    const zipBuf = Buffer.from(cleanB64, "base64");
    if (zipBuf.byteLength === 0) {
      return sendJson(res, 400, { error: "上传的 ZIP 文件为空" });
    }
    entries = await extractZipToSkillFiles(zipBuf);
  } else if (Array.isArray(body.files) && body.files.length > 0) {
    const rawFiles = (
      body.files as Array<{ path?: unknown; content?: unknown; encoding?: unknown }>
    )
      .filter(
        (item) =>
          typeof item.path === "string" &&
          item.path.trim().length > 0 &&
          typeof item.content === "string"
      )
      .map((item) => ({
        path: String(item.path).replace(/\\/g, "/").replace(/^\/+/, ""),
        content: String(item.content),
        encoding: (item.encoding === "base64" ? "base64" : "utf-8") as SkillFileEncoding,
      }));

    const stripped = stripCommonTopFolder(rawFiles);
    const hasSkillMd = stripped.some((f) => f.path === "SKILL.md");
    const mapped =
      !hasSkillMd &&
      stripped.length === 1 &&
      stripped[0].path.toLowerCase().endsWith(".md")
        ? [{ ...stripped[0], path: "SKILL.md" }]
        : stripped;

    entries = mapped.map((item) =>
      enrichSkillFileEntry({
        path: normalizeRelativeSkillPath(item.path),
        content: item.content,
        encoding: item.encoding,
      })
    );
  } else {
    return sendJson(res, 400, {
      error: "请上传 Skill ZIP 压缩包、Skill 文件夹或 SKILL.md 文件",
    });
  }

  const skillMdEntry = entries.find((f) => f.path === "SKILL.md");
  if (!skillMdEntry || skillMdEntry.encoding === "base64") {
    return sendJson(res, 400, {
      error: "上传的内容中未找到有效的 SKILL.md 文件",
    });
  }

  const frontmatter = parseSkillFrontmatter(skillMdEntry.content);
  const fmName =
    typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const fallbackFileBase = fileName.replace(/\.(zip|md)$/i, "").trim();
  const skillName = normalizeSkillName(
    rawSkillName || fmName || fallbackFileBase || "uploaded-skill"
  );
  const description =
    rawDescription ||
    extractDescriptionFromMarkdown(skillMdEntry.content, skillName);

  const saved = await saveSkillFilesToDefaultDir({
    skillName,
    files: entries,
    scope: "global",
  });
  await replaceSkillFiles(skillName, entries);

  const { hasScripts, summary: resourceSummary } =
    buildResourceSummary(entries);

  const card = await upsertSkillCard(skillName, {
    description,
    creator,
    currentStep: 1,
    progress: 33,
    status: "draft",
    frontmatter,
    hasScripts,
    resourceSummary,
  });

  const persistedFiles = await listSkillFiles(skillName).catch(() => entries);
  sendJson(res, 201, {
    card,
    skillName,
    filePath: saved.filePath,
    files: persistedFiles,
  });
}
