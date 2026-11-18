import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  discoverSkills,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { resolveOpenAIEnvSessionOptions } from "../config/envModel.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import {
  findSkillInDefaultDir,
  normalizeSkillName,
} from "../repositories/skillStorage.js";

export interface RunSkillOptions {
  skillName: string;
  cwd: string;
  taskPrompt?: string;
  modelPattern?: string;
  onDelta?: (chunk: string) => void;
}

export interface RunSkillResult {
  skillName: string;
  cwd: string;
  output: string;
  durationMs: number;
  modelFallbackMessage?: string;
}

export async function runSkillInRepo(
  options: RunSkillOptions
): Promise<RunSkillResult> {
  const startTime = Date.now();
  const skillName = normalizeSkillName(options.skillName);
  const targetCwd = path.resolve(options.cwd);

  const stat = await fs.stat(targetCwd).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Target repository directory does not exist: ${targetCwd}`);
  }

  const projectSkill = await findSkillInDefaultDir(skillName, "project", targetCwd);
  const globalSkill = await findSkillInDefaultDir(skillName, "global", targetCwd);
  if (!projectSkill && !globalSkill) {
    throw new Error(
      `Skill "${skillName}" not found in default directories (.omp/skills or ~/.omp/agent/skills).`
    );
  }

  const { skills: discoveredSkills } = await discoverSkills(targetCwd);
  const modelPattern = options.modelPattern || process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions()
    : null;

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: targetCwd,
    skills: discoveredSkills,
    sessionManager: SessionManager.inMemory(),
    telemetry: buildSessionTelemetryConfig({
      operation: "skill_run",
      skillName,
      extraAttributes: { "repo.cwd": targetCwd },
    }),
    ...(modelPattern ? { modelPattern } : {}),
    ...(envModelOptions ?? {}),
  });

  let output = "";
  let lastErrorMessage: string | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      output += delta;
      options.onDelta?.(delta);
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      lastErrorMessage = event.message.errorMessage || "Unknown AI provider error";
    }
  });

  try {
    const instruction = options.taskPrompt?.trim()
      ? `/skill:${skillName} ${options.taskPrompt.trim()}`
      : `/skill:${skillName} Execute the skill workflow on the current repository.`;

    await session.prompt(instruction);
  } finally {
    unsubscribe();
    await session.dispose();
  }

  if (lastErrorMessage && !output.trim()) {
    const modelLabel = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "unknown";
    throw new Error(`AI request failed (${modelLabel}): ${lastErrorMessage}`);
  }

  return {
    skillName,
    cwd: targetCwd,
    output,
    durationMs: Date.now() - startTime,
    modelFallbackMessage,
  };
}
