import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  discoverSkills,
  SessionManager,
  type AgentSession,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { MCPManager, type MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp";
import {
  resolveOpenAIEnvSessionOptions,
  type OpenAIOverrideConfig,
} from "../config/envModel.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import { isDbConnected } from "../db/database.js";
import { listSkillFiles } from "../repositories/skillRepository.js";
import {
  buildResourceSummary,
  enrichSkillFileEntry,
  extractDescriptionFromMarkdown,
  findSkillInDefaultDir,
  normalizeRelativeSkillPath,
  normalizeSkillName,
  parseSkillFrontmatter,
  readSkillDirectoryFiles,
  resolveDefaultSkillsRoot,
  saveSkillFilesToDefaultDir,
} from "../repositories/skillStorage.js";
import type {
  SavedSkillInfo,
  SkillFileEntry,
  SkillScope,
  UserMcpServer,
} from "../types/skill.js";

const BASE_GENERATOR_SKILL = "skill-creator";

export interface GenerateSkillOptions {
  userPrompt: string;
  skillName?: string;
  scope?: SkillScope;
  cwd?: string;
  modelPattern?: string;
  openaiConfig?: OpenAIOverrideConfig;
  mcpServers?: UserMcpServer[];
  onDelta?: (chunk: string) => void;
  onProgress?: (message: string) => void;
  onSessionReady?: (session: AgentSession) => void;
  abortSignal?: AbortSignal;
  jobId?: string;
}

export interface GenerateSkillResult {
  saved: SavedSkillInfo;
  content: string;
  files: SkillFileEntry[];
  frontmatter: Record<string, unknown>;
  hasScripts: boolean;
  resourceSummary: ReturnType<typeof buildResourceSummary>["summary"];
  modelFallbackMessage?: string;
}

async function ensureBaseSkillCreatorAvailable(
  targetCwd: string
): Promise<Skill[]> {
  const builtinDir = path.resolve(
    process.cwd(),
    "resource",
    "builtin-skills",
    BASE_GENERATOR_SKILL
  );
  const globalSkillDir = path.join(
    resolveDefaultSkillsRoot("global", targetCwd),
    BASE_GENERATOR_SKILL
  );

  // 1. Prefer database as the primary source of truth; restore to agent dirs if missing
  let dbSkillMdContent = "";
  if (isDbConnected()) {
    const dbFiles = await listSkillFiles(BASE_GENERATOR_SKILL).catch(() => []);
    const dbSkillMd = dbFiles.find((f) => f.path === "SKILL.md");
    if (dbFiles.length > 0 && dbSkillMd?.content) {
      dbSkillMdContent = dbSkillMd.content;
      const existingOnDisk = await findSkillInDefaultDir(
        BASE_GENERATOR_SKILL,
        "global",
        targetCwd
      ).catch(() => null);
      if (!existingOnDisk) {
        await saveSkillFilesToDefaultDir({
          skillName: BASE_GENERATOR_SKILL,
          files: dbFiles,
          scope: "global",
        }).catch(() => { });
      }
    }
  }

  // 2. Fallback to resource/builtin-skills if not in DB yet (e.g. CLI without initDatabase)
  if (!dbSkillMdContent) {
    const existing = await findSkillInDefaultDir(
      BASE_GENERATOR_SKILL,
      "global",
      targetCwd
    ).catch(() => null);
    if (!existing) {
      const files = await readSkillDirectoryFiles(builtinDir);
      if (files.some((f) => f.path === "SKILL.md")) {
        await saveSkillFilesToDefaultDir({
          skillName: BASE_GENERATOR_SKILL,
          files,
          scope: "global",
        }).catch(() => { });
      }
    }
  }

  const { skills: discoveredSkills } = await discoverSkills(targetCwd);
  if (discoveredSkills.some((s) => s.name === BASE_GENERATOR_SKILL)) {
    return discoveredSkills;
  }

  // 3. Guarantee skill-creator is available even if OMP global dir is outside cwd/sandbox
  const fallbackBaseDir = dbSkillMdContent ? globalSkillDir : builtinDir;
  const fallbackFilePath = path.join(fallbackBaseDir, "SKILL.md");
  const fallbackContent =
    dbSkillMdContent ||
    (await fs.readFile(path.join(builtinDir, "SKILL.md"), "utf-8").catch(() => ""));

  if (!fallbackContent) {
    throw new Error(
      `Base generator skill "${BASE_GENERATOR_SKILL}" not found in database or ${builtinDir}`
    );
  }

  const fallbackSkill: Skill = {
    name: BASE_GENERATOR_SKILL,
    description: extractDescriptionFromMarkdown(
      fallbackContent,
      "Create new skills, modify and improve existing skills, and measure skill performance."
    ),
    filePath: fallbackFilePath,
    baseDir: fallbackBaseDir,
    source: dbSkillMdContent ? "database" : "builtin",
  };

  return [fallbackSkill, ...discoveredSkills];
}

function buildSkillCreatorPrompt(
  userPrompt: string,
  targetSkillName?: string,
  targetSkillDir?: string
): string {
  const lines = [
    `/skill:${BASE_GENERATOR_SKILL}`,
    `Non-interactive mode: Do NOT ask clarifying questions or wait for user confirmation. Immediately design and generate the complete skill package based on the user request below, following ${BASE_GENERATOR_SKILL} authoring standards.`,
    `Efficiency rule: Skip multi-round eval loops, benchmark viewers, and package_skill.py unless the user explicitly asks to run evals. Focus on producing a complete, accurate SKILL.md and any needed helper scripts/references/assets.`,
    targetSkillName ? `Target skill name: ${targetSkillName}` : "",
    targetSkillDir ? `Target skill directory (if writing files): ${targetSkillDir}` : "",
    `Strict output requirements:`,
    `1. Output the raw SKILL.md content FIRST in your response (no conversational preamble). Start with YAML frontmatter enclosed by "---" containing \`name\` (kebab-case) and \`description\`, followed by clear Markdown instructions.`,
    `2. If the skill benefits from helper scripts (scripts/), reference docs (references/), templates/assets (assets/), or sub-agents (agents/), append each bundled file AFTER SKILL.md using this exact delimiter format:`,
    `===FILE: <relative-path>===`,
    `<file content>`,
    `===END_FILE===`,
    ``,
    `User request:`,
    userPrompt,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function unwrapMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() + "\n" : trimmed + "\n";
}

function extractFrontmatterName(content: string): string | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const nameLine = fmMatch[1].match(/^name:\s*["']?([a-zA-Z0-9_-]+)["']?\s*$/m);
  return nameLine ? nameLine[1] : null;
}

function ensureValidSkillMarkdown(
  rawOutput: string,
  explicitName?: string
): { skillName: string; content: string } {
  let content = unwrapMarkdownFence(rawOutput);
  const parsedName = extractFrontmatterName(content);
  const skillName = normalizeSkillName(
    explicitName || parsedName || `custom-skill-${Date.now()}`
  );

  if (!content.startsWith("---")) {
    content = `---\nname: ${skillName}\ndescription: Custom AI-generated skill\n---\n\n${content}`;
  } else if (explicitName && parsedName !== skillName) {
    content = content.replace(
      /^(---\s*\n[\s\S]*?^name:\s*)(.+)$/m,
      `$1${skillName}`
    );
  }

  return { skillName, content };
}

function parseGeneratedSkillPackage(
  rawOutput: string,
  explicitName?: string
): { skillName: string; content: string; files: Required<SkillFileEntry>[] } {
  const fileBlockRegex =
    /===FILE:\s*([^\r\n=]+?)\s*===\r?\n([\s\S]*?)\r?\n===END_FILE===/g;

  const extraFiles: SkillFileEntry[] = [];
  let firstMatchIndex = rawOutput.length;
  let match: RegExpExecArray | null;

  while ((match = fileBlockRegex.exec(rawOutput)) !== null) {
    if (match.index < firstMatchIndex) {
      firstMatchIndex = match.index;
    }
    const rawRelPath = match[1].trim();
    const fileContent = match[2];
    try {
      const relPath = normalizeRelativeSkillPath(rawRelPath);
      if (relPath !== "SKILL.md") {
        extraFiles.push({ path: relPath, content: fileContent.trimEnd() + "\n" });
      }
    } catch {
      // Ignore invalid paths emitted by model
    }
  }

  const skillMdRaw = rawOutput.slice(0, firstMatchIndex).trim();
  const { skillName, content } = ensureValidSkillMarkdown(
    skillMdRaw || rawOutput,
    explicitName
  );

  const files: Required<SkillFileEntry>[] = [
    enrichSkillFileEntry({ path: "SKILL.md", content }),
    ...extraFiles.map((f) => enrichSkillFileEntry(f)),
  ];

  return { skillName, content, files };
}

export async function generateSkillFromPrompt(
  options: GenerateSkillOptions
): Promise<GenerateSkillResult> {
  if (!options.userPrompt.trim()) {
    throw new Error("userPrompt must not be empty");
  }

  const targetCwd = path.resolve(options.cwd || process.cwd());
  const scope = options.scope ?? "global";
  const discoveredSkills = await ensureBaseSkillCreatorAvailable(targetCwd);
  const targetSkillName = options.skillName
    ? normalizeSkillName(options.skillName)
    : undefined;
  const targetSkillDir = targetSkillName
    ? path.join(resolveDefaultSkillsRoot(scope, targetCwd), targetSkillName)
    : undefined;

  let mcpManager: MCPManager | undefined;
  const connectedMcpNames: string[] = [];
  if (options.mcpServers && options.mcpServers.length > 0) {
    mcpManager = new MCPManager(targetCwd);
    const configs: Record<string, MCPServerConfig> = {};
    const sources: Record<string, { provider: string; providerName: string; path: string; level: "user" }> = {};
    for (const srv of options.mcpServers) {
      configs[srv.name] = {
        type: "http",
        url: srv.url,
        ...(Object.keys(srv.headers).length > 0 ? { headers: srv.headers } : {}),
        enabled: true,
      };
      sources[srv.name] = {
        provider: "user",
        providerName: "user-streamable-http",
        path: srv.url,
        level: "user",
      };
    }
    options.onProgress?.(
      `正在连接 ${options.mcpServers.length} 个 Streamable HTTP MCP 服务...`
    );
    const loadRes = await mcpManager.connectServers(configs, sources as never);
    connectedMcpNames.push(...loadRes.connectedServers);
    if (loadRes.errors.size > 0) {
      for (const [srvName, errMsg] of loadRes.errors.entries()) {
        options.onProgress?.(`MCP "${srvName}" 连接警告: ${errMsg}`);
      }
    }
  }

  const hasOpenAIOverride = Boolean(
    options.openaiConfig?.apiKey?.trim() ||
    options.openaiConfig?.modelName?.trim() ||
    options.openaiConfig?.baseUrl?.trim()
  );
  const modelPattern = hasOpenAIOverride
    ? undefined
    : options.modelPattern || process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions(options.openaiConfig)
    : null;
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: targetCwd,
    skills: discoveredSkills,
    ...(mcpManager ? { mcpManager, enableMCP: true } : {}),
    sessionManager: SessionManager.inMemory(targetCwd),
    telemetry: buildSessionTelemetryConfig({
      operation: "skill_generate",
      skillName: targetSkillName,
      jobId: options.jobId,
      extraAttributes: { "skill.base": BASE_GENERATOR_SKILL },
    }),
    ...(modelPattern ? { modelPattern } : {}),
    ...(envModelOptions ?? {}),
  });

  options.onSessionReady?.(session);

  let rawOutput = "";
  let lastErrorMessage: string | undefined;
  let wasAborted = false;
  let reportedThinking = false;
  const writtenSkillDirs = new Set<string>();

  const onAbortSignal = () => {
    wasAborted = true;
    void session.abort({
      goalReason: "interrupted",
      reason: "Generation interrupted by user or timeout",
    });
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onAbortSignal();
    } else {
      options.abortSignal.addEventListener("abort", onAbortSignal, { once: true });
    }
  }

  options.onProgress?.("正在启动 skill-creator 会话...");

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        rawOutput += delta;
        options.onDelta?.(delta);
      } else if (
        event.assistantMessageEvent.type === "thinking_delta" &&
        !reportedThinking
      ) {
        reportedThinking = true;
        options.onProgress?.("skill-creator 正在思考与规划 Skill 结构...");
      }
    } else if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const argPath = typeof args.path === "string" ? args.path : "";
      const argCmd = typeof args.command === "string" ? args.command : "";
      const detail = argPath || (argCmd ? argCmd.slice(0, 80) : "");
      options.onProgress?.(
        `正在执行工具 ${event.toolName}${detail ? `: ${detail}` : ""}`
      );
      if (
        (event.toolName === "write" || event.toolName === "edit") &&
        argPath.endsWith("SKILL.md")
      ) {
        writtenSkillDirs.add(path.dirname(path.resolve(targetCwd, argPath)));
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "aborted") {
        wasAborted = true;
        lastErrorMessage =
          event.message.errorMessage || "Generation interrupted";
      } else if (event.message.stopReason === "error") {
        lastErrorMessage =
          event.message.errorMessage || "Unknown AI provider error";
      }
    }
  });

  try {
    const mcpContext =
      connectedMcpNames.length > 0
        ? `\n\nConnected Streamable HTTP MCP servers available in this session: ${connectedMcpNames.join(", ")}`
        : "";
    const prompt = buildSkillCreatorPrompt(
      `${options.userPrompt}${mcpContext}`,
      targetSkillName,
      targetSkillDir
    );
    await session.prompt(prompt);
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbortSignal);
    unsubscribe();
    await session.dispose();
    if (mcpManager) {
      await mcpManager.disconnectAll().catch(() => { });
    }
  }

  if (wasAborted || options.abortSignal?.aborted) {
    const err = new Error(lastErrorMessage || "Skill generation was aborted");
    err.name = "AbortError";
    throw err;
  }

  if (lastErrorMessage && !rawOutput.trim()) {
    const modelLabel = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "unknown";
    throw new Error(`AI request failed (${modelLabel}): ${lastErrorMessage}`);
  }

  // Fallback: if skill-creator wrote files directly to a skill directory via tools
  let parsed: { skillName: string; content: string; files: Required<SkillFileEntry>[] } | null =
    null;

  const candidateDirs: string[] = [];
  if (targetSkillDir) candidateDirs.push(targetSkillDir);
  for (const dir of writtenSkillDirs) {
    if (!candidateDirs.includes(dir)) candidateDirs.push(dir);
  }

  if (!rawOutput.includes("---")) {
    for (const dir of candidateDirs) {
      const diskFiles = await readSkillDirectoryFiles(dir);
      const diskSkillMd = diskFiles.find((f) => f.path === "SKILL.md");
      if (diskSkillMd && diskSkillMd.content.trim()) {
        const resolvedName =
          targetSkillName ||
          normalizeSkillName(
            extractFrontmatterName(diskSkillMd.content) || path.basename(dir)
          );
        parsed = {
          skillName: resolvedName,
          content: diskSkillMd.content,
          files: diskFiles,
        };
        break;
      }
    }
  }

  if (!parsed) {
    if (!rawOutput.trim()) {
      throw new Error("AI returned empty output while generating skill");
    }
    parsed = parseGeneratedSkillPackage(rawOutput, targetSkillName);
  }

  const { skillName, content, files } = parsed;

  const saved = await saveSkillFilesToDefaultDir({
    skillName,
    files,
    scope,
    cwd: targetCwd,
  });

  const frontmatter = parseSkillFrontmatter(content);
  const { summary: resourceSummary, hasScripts } = buildResourceSummary(files);

  return {
    saved,
    content,
    files,
    frontmatter,
    hasScripts,
    resourceSummary,
    modelFallbackMessage,
  };
}
