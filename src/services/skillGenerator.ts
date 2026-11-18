import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  discoverSkills,
  SessionManager,
  type AgentSession,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { resolveOpenAIEnvSessionOptions } from "../config/envModel.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
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
import type { SavedSkillInfo, SkillFileEntry, SkillScope } from "../types/skill.js";

const BASE_GENERATOR_SKILL = "skill-creator";

export interface GenerateSkillOptions {
  userPrompt: string;
  skillName?: string;
  scope?: SkillScope;
  cwd?: string;
  modelPattern?: string;
  onDelta?: (chunk: string) => void;
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

  const { skills: discoveredSkills } = await discoverSkills(targetCwd);
  if (discoveredSkills.some((s) => s.name === BASE_GENERATOR_SKILL)) {
    return discoveredSkills;
  }

  // Guarantee skill-creator is available even if OMP global dir is outside cwd/sandbox
  const builtinSkillMdPath = path.join(builtinDir, "SKILL.md");
  const builtinContent = await fs
    .readFile(builtinSkillMdPath, "utf-8")
    .catch(() => "");
  if (!builtinContent) {
    throw new Error(
      `Base generator skill "${BASE_GENERATOR_SKILL}" not found at ${builtinSkillMdPath}`
    );
  }

  const fallbackSkill: Skill = {
    name: BASE_GENERATOR_SKILL,
    description: extractDescriptionFromMarkdown(
      builtinContent,
      "Create new skills, modify and improve existing skills, and measure skill performance."
    ),
    filePath: builtinSkillMdPath,
    baseDir: builtinDir,
    source: "builtin",
  };

  return [fallbackSkill, ...discoveredSkills];
}

function buildSkillCreatorPrompt(
  userPrompt: string,
  targetSkillName?: string
): string {
  const lines = [
    `/skill:${BASE_GENERATOR_SKILL}`,
    `Non-interactive mode: Do NOT ask clarifying questions or wait for user confirmation. Immediately design and generate the complete skill package based on the user request below, following all ${BASE_GENERATOR_SKILL} guidelines.`,
    targetSkillName ? `Target skill name: ${targetSkillName}` : "",
    `Strict output requirements:`,
    `1. Output the raw SKILL.md content FIRST (no conversational preamble). Start with YAML frontmatter enclosed by "---" containing \`name\` (kebab-case) and \`description\`, followed by clear Markdown instructions.`,
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
  const discoveredSkills = await ensureBaseSkillCreatorAvailable(targetCwd);
  const targetSkillName = options.skillName
    ? normalizeSkillName(options.skillName)
    : undefined;

  const modelPattern = options.modelPattern || process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions()
    : null;
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: targetCwd,
    skills: discoveredSkills,
    sessionManager: SessionManager.inMemory(),
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

  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      rawOutput += delta;
      options.onDelta?.(delta);
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
    const prompt = buildSkillCreatorPrompt(options.userPrompt, targetSkillName);
    await session.prompt(prompt);
  } finally {
    options.abortSignal?.removeEventListener("abort", onAbortSignal);
    unsubscribe();
    await session.dispose();
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

  // Fallback: if skill-creator wrote files directly to the target skill directory via tools
  const scope = options.scope ?? "global";
  let parsed: { skillName: string; content: string; files: Required<SkillFileEntry>[] } | null =
    null;

  if (targetSkillName && !rawOutput.includes("---")) {
    const diskDir = path.join(
      resolveDefaultSkillsRoot(scope, targetCwd),
      targetSkillName
    );
    const diskFiles = await readSkillDirectoryFiles(diskDir);
    const diskSkillMd = diskFiles.find((f) => f.path === "SKILL.md");
    if (diskSkillMd && diskSkillMd.content.trim()) {
      parsed = {
        skillName: targetSkillName,
        content: diskSkillMd.content,
        files: diskFiles,
      };
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
