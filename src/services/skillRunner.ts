import fs from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  discoverSkills,
  SessionManager,
  type Skill,
} from "@oh-my-pi/pi-coding-agent";
import { resolveOpenAIEnvSessionOptions } from "../config/envModel.js";
import { createLogger } from "../config/logger.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import {
  findEmbeddedSkill,
  materializeEmbeddedSkills,
} from "../repositories/embeddedSkills.js";
import {
  findSkillInDefaultDir,
  normalizeSkillName,
} from "../repositories/skillStorage.js";
import { BackgroundCommandManager } from "../workbench/extensions/backgroundCommands.js";
import { buildWorkbenchExtensions } from "../workbench/extensions/registry.js";
import { TodoSessionStore } from "../workbench/extensions/todos.js";

const log = createLogger("skill-runner");

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

/**
 * Shared non-interactive execution prompt used consistently across:
 * - CLI `ai-pipeline run` (and Jenkins binary execution)
 * - Local / pipeline test (`real` mode)
 */
export function buildSkillExecutionPrompt(
  skillName: string,
  taskPrompt?: string
): string {
  const normalized = normalizeSkillName(skillName);
  const body = taskPrompt?.trim()
    ? taskPrompt.trim()
    : "Execute the skill workflow on the current repository.";
  return [
    `/skill:${normalized}`,
    `Non-interactive execution mode: Follow the instructions and scripts defined in skill "${normalized}" strictly without asking clarifying questions. Verify your results before finishing.`,
    body,
  ].join("\n\n");
}

function mergeSkillsByName(
  discovered: Skill[],
  embedded: Skill[]
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of discovered) {
    byName.set(s.name, s);
  }
  // Embedded database skills take precedence so bundled binary always runs its exact snapshot
  for (const s of embedded) {
    if (!byName.has(s.name) || s.source === "embedded:database") {
      byName.set(s.name, s);
    }
  }
  return [...byName.values()];
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

  // 1. Materialize any binary-embedded skills (built-in + optional DB-bundled skills)
  const embeddedPkg = findEmbeddedSkill(skillName);
  const materialized = await materializeEmbeddedSkills({
    forceOverwrite: embeddedPkg?.source === "database",
  });

  const projectSkill = await findSkillInDefaultDir(skillName, "project", targetCwd);
  const globalSkill = await findSkillInDefaultDir(skillName, "global", targetCwd);
  const embeddedSkillEntry = materialized.skills.find((s) => s.name === skillName);

  if (!projectSkill && !globalSkill && !embeddedSkillEntry) {
    throw new Error(
      `Skill "${skillName}" not found in binary-embedded bundle or default directories (.omp/skills or ~/.omp/agent/skills).`
    );
  }

  const { skills: discoveredSkills } = await discoverSkills(targetCwd);
  const allSkills = mergeSkillsByName(discoveredSkills, materialized.skills);

  const modelPattern = options.modelPattern || process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions()
    : null;

  // 2. Equip the same non-interactive workbench toolset (todos + background-commands)
  //    so execution behavior stays consistent with Creative Mode & Pipeline Tests
  const todoStore = new TodoSessionStore();
  const bgCommandManager = new BackgroundCommandManager(targetCwd, () => {});
  const extBundle = buildWorkbenchExtensions(
    ["ask-user-question", "next-steps", "visualize", "skill-distiller"],
    {
      sessionId: `run_${skillName}_${startTime}`,
      owner: "runner",
      cwd: targetCwd,
      selectedMcps: [],
      todoStore,
      bgCommandManager,
      setNextSteps: () => {},
      askUserQuestion: async (q) => ({
        toolCallId: q.toolCallId,
        answers: [],
        cancelled: true,
      }),
      onSkillSaved: () => {},
      onStateChange: () => {},
    }
  );

  log.info(
    {
      skillName,
      cwd: targetCwd,
      source: embeddedPkg
        ? `embedded:${embeddedPkg.source}`
        : projectSkill
          ? "project"
          : "global",
      enabledExtensions: extBundle.enabledIds,
    },
    "Starting skill execution session"
  );

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: targetCwd,
    skills: allSkills,
    ...(extBundle.factories.length > 0
      ? { extensions: extBundle.factories }
      : {}),
    ...(extBundle.appendSystemPrompt
      ? { appendSystemPrompt: extBundle.appendSystemPrompt }
      : {}),
    sessionManager: SessionManager.inMemory(targetCwd),
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
    } else if (event.type === "tool_execution_end") {
      log.info(
        {
          skillName,
          toolName: event.toolName,
          isError: Boolean(event.isError),
        },
        event.isError ? "Skill runner tool failed" : "Skill runner tool finished"
      );
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      lastErrorMessage = event.message.errorMessage || "Unknown AI provider error";
    }
  });

  try {
    const instruction = buildSkillExecutionPrompt(skillName, options.taskPrompt);
    await session.prompt(instruction);
  } finally {
    unsubscribe();
    bgCommandManager.dispose();
    await session.dispose();
  }

  if (lastErrorMessage && !output.trim()) {
    const modelLabel = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "unknown";
    throw new Error(`AI request failed (${modelLabel}): ${lastErrorMessage}`);
  }

  const durationMs = Date.now() - startTime;
  log.info({ skillName, cwd: targetCwd, durationMs }, "Skill execution finished");

  return {
    skillName,
    cwd: targetCwd,
    output,
    durationMs,
    modelFallbackMessage,
  };
}
