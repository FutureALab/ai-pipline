import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { resolveOpenAIEnvSessionOptions } from "../config/envModel.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import {
  normalizeSkillName,
  saveSkillToDefaultDir,
} from "../repositories/skillStorage.js";
import type { SavedSkillInfo, SkillScope } from "../types/skill.js";

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
  modelFallbackMessage?: string;
}

const SKILL_GENERATION_INSTRUCTION = `You are an expert OMP (oh-my-pi) Skill author.
Generate a complete, ready-to-use SKILL.md file based on the user's request.

Strict output requirements:
1. Output ONLY the raw SKILL.md content (no extra conversational preamble or trailing explanation).
2. Start with YAML frontmatter enclosed by "---":
   - name: kebab-case identifier (letters, digits, hyphens only)
   - description: concise one-line description of when and why the agent should use this skill
3. Follow the frontmatter with clear, actionable Markdown instructions:
   - Purpose / Overview
   - Step-by-step execution workflow
   - Constraints, edge cases, and verification criteria
   - Expected output format`;

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

export async function generateSkillFromPrompt(
  options: GenerateSkillOptions
): Promise<GenerateSkillResult> {
  if (!options.userPrompt.trim()) {
    throw new Error("userPrompt must not be empty");
  }

  const modelPattern = options.modelPattern || process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions()
    : null;
  const { session, modelFallbackMessage } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    telemetry: buildSessionTelemetryConfig({
      operation: "skill_generate",
      skillName: options.skillName,
      jobId: options.jobId,
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
    const nameHint = options.skillName
      ? `\nTarget skill name: ${normalizeSkillName(options.skillName)}`
      : "";

    const prompt = `${SKILL_GENERATION_INSTRUCTION}${nameHint}\n\nUser request:\n${options.userPrompt}`;
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

  if (!rawOutput.trim()) {
    throw new Error("AI returned empty output while generating skill");
  }

  const { skillName, content } = ensureValidSkillMarkdown(
    rawOutput,
    options.skillName
  );

  const saved = await saveSkillToDefaultDir({
    skillName,
    content,
    scope: options.scope ?? "global",
    cwd: options.cwd,
  });

  return {
    saved,
    content,
    modelFallbackMessage,
  };
}
