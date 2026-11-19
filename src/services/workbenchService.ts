import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  discoverSkills,
  SessionManager,
  type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { MCPManager, type MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp";
import {
  resolveOpenAIEnvSessionOptions,
  type OpenAIOverrideConfig,
} from "../config/envModel.js";
import { createLogger } from "../config/logger.js";
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import { getMcpServersByIdsForOwner } from "../repositories/mcpRepository.js";
import { listCatalogRepos } from "../repositories/skillRepository.js";
import { BackgroundCommandManager } from "../workbench/extensions/backgroundCommands.js";
import {
  buildWorkbenchExtensions,
  getWorkbenchExtensionCatalog,
} from "../workbench/extensions/registry.js";
import { TodoSessionStore } from "../workbench/extensions/todos.js";
import type {
  PendingUserQuestion,
  UserQuestionSubmission,
  WorkbenchBackgroundCommandSnapshot,
  WorkbenchExtensionDescriptor,
  WorkbenchExtensionId,
  WorkbenchNextStep,
  WorkbenchTodoState,
  WorkbenchToolCall,
} from "../workbench/types.js";

const execFileAsync = promisify(execFile);
const wbLog = createLogger("workbench");

const MAX_TOOL_RESULT_CHARS = 18_000;

export interface WorkbenchMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolLogs?: string[];
  toolCalls?: WorkbenchToolCall[];
  createdAt: number;
}

export interface WorkbenchSkillItem {
  name: string;
  description: string;
  source: string;
}

export interface WorkbenchMcpStatusItem {
  id: string;
  name: string;
  url: string;
  status: "connected" | "connecting" | "disconnected";
  tools: string[];
}

export interface WorkbenchSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

export interface WorkbenchModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
}

export interface WorkbenchSessionSnapshot {
  sessionId: string;
  owner: string;
  repoId?: string;
  repoName?: string;
  repoUrl?: string;
  cwd: string;
  selectedMcps: string[];
  enabledExtensions: WorkbenchExtensionId[];
  disabledExtensions: string[];
  status: "idle" | "running" | "error";
  messages: WorkbenchMessage[];
  streamingText: string;
  streamingThinking: string;
  streamingLogs: string[];
  streamingToolCalls: WorkbenchToolCall[];
  pendingQuestion: PendingUserQuestion | null;
  nextSteps: WorkbenchNextStep[];
  todos: WorkbenchTodoState;
  backgroundCommands: WorkbenchBackgroundCommandSnapshot[];
  errorMessage?: string;
  model: WorkbenchModelInfo | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  stats: WorkbenchSessionStats;
  skills: WorkbenchSkillItem[];
  mcpServers: WorkbenchMcpStatusItem[];
  updatedAt: number;
}

interface PendingQuestionWaiter {
  question: PendingUserQuestion;
  resolve: (submission: UserQuestionSubmission) => void;
}

interface InternalWorkbenchSession {
  sessionId: string;
  owner: string;
  repoId?: string;
  repoName?: string;
  repoUrl?: string;
  cwd: string;
  selectedMcps: string[];
  enabledExtensions: WorkbenchExtensionId[];
  disabledExtensions: string[];
  status: "idle" | "running" | "error";
  messages: WorkbenchMessage[];
  streamingText: string;
  streamingThinking: string;
  streamingLogs: string[];
  streamingToolCalls: WorkbenchToolCall[];
  pendingQuestionWaiter: PendingQuestionWaiter | null;
  nextSteps: WorkbenchNextStep[];
  todoStore: TodoSessionStore;
  bgCommandManager: BackgroundCommandManager;
  errorMessage?: string;
  updatedAt: number;
  isTempDir: boolean;
  agentSession: AgentSession;
  mcpManager?: MCPManager;
  skills: WorkbenchSkillItem[];
  configuredMcps: Array<{ id: string; name: string; url: string }>;
}

const sessions = new Map<string, InternalWorkbenchSession>();

export function listWorkbenchExtensions(): WorkbenchExtensionDescriptor[] {
  return getWorkbenchExtensionCatalog();
}

function extractToolResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") {
    return result.slice(0, MAX_TOOL_RESULT_CHARS);
  }
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const block of obj.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b.type === "image") {
        parts.push("[image]");
      }
    }
    const joined = parts.join("\n");
    return joined.length > MAX_TOOL_RESULT_CHARS
      ? `${joined.slice(0, MAX_TOOL_RESULT_CHARS)}\n...(truncated)`
      : joined;
  }
  if (typeof obj.text === "string") {
    return obj.text.slice(0, MAX_TOOL_RESULT_CHARS);
  }
  try {
    const serialized = JSON.stringify(result, null, 2);
    return serialized.length > MAX_TOOL_RESULT_CHARS
      ? `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n...(truncated)`
      : serialized;
  } catch {
    return String(result).slice(0, MAX_TOOL_RESULT_CHARS);
  }
}

function extractToolDetails(
  result: unknown
): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as Record<string, unknown>).details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return undefined;
}

function buildStatsSnapshot(agentSession: AgentSession): WorkbenchSessionStats {
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  try {
    const rawStats = agentSession.getSessionStats();
    tokens = {
      input: rawStats.tokens?.input ?? 0,
      output: rawStats.tokens?.output ?? 0,
      cacheRead: rawStats.tokens?.cacheRead ?? 0,
      cacheWrite: rawStats.tokens?.cacheWrite ?? 0,
      total: rawStats.tokens?.total ?? 0,
    };
    cost = rawStats.cost ?? 0;
  } catch {
    // Ignore if stats unavailable
  }

  let contextUsage: WorkbenchSessionStats["contextUsage"] = null;
  try {
    const usage = agentSession.getContextUsage();
    if (usage) {
      contextUsage = {
        tokens: usage.tokens ?? null,
        contextWindow:
          usage.contextWindow ?? agentSession.model?.contextWindow ?? 128000,
        percent: usage.percent ?? null,
      };
    } else if (agentSession.model?.contextWindow) {
      contextUsage = {
        tokens: 0,
        contextWindow: agentSession.model.contextWindow,
        percent: 0,
      };
    }
  } catch {
    // Ignore if context usage unavailable
  }

  return { tokens, cost, contextUsage };
}

function buildMcpStatusList(
  s: InternalWorkbenchSession
): WorkbenchMcpStatusItem[] {
  if (!s.mcpManager || s.configuredMcps.length === 0) return [];
  const allTools = s.mcpManager.getTools();
  return s.configuredMcps.map((srv) => {
    const status = s.mcpManager!.getConnectionStatus(srv.name);
    const prefix = `mcp__${srv.name}_`;
    const tools = allTools
      .filter((t) => t.name.startsWith(prefix) || t.name.includes(srv.name))
      .map((t) => t.name);
    return {
      id: srv.id,
      name: srv.name,
      url: srv.url,
      status,
      tools,
    };
  });
}

function cloneToolCall(tc: WorkbenchToolCall): WorkbenchToolCall {
  return {
    ...tc,
    args: { ...tc.args },
    ...(tc.details ? { details: tc.details } : {}),
  };
}

function toSnapshot(s: InternalWorkbenchSession): WorkbenchSessionSnapshot {
  const m = s.agentSession.model;
  const model: WorkbenchModelInfo | null = m
    ? {
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow ?? 128000,
        reasoning: Boolean(m.reasoning),
      }
    : null;

  let availableThinkingLevels: string[] = [];
  try {
    availableThinkingLevels = [...s.agentSession.getAvailableThinkingLevels()];
  } catch {
    availableThinkingLevels = ["off", "low", "medium", "high"];
  }
  if (availableThinkingLevels.length === 0) {
    availableThinkingLevels = ["off", "minimal", "low", "medium", "high"];
  }

  return {
    sessionId: s.sessionId,
    owner: s.owner,
    repoId: s.repoId,
    repoName: s.repoName,
    repoUrl: s.repoUrl,
    cwd: s.cwd,
    selectedMcps: [...s.selectedMcps],
    enabledExtensions: [...s.enabledExtensions],
    disabledExtensions: [...s.disabledExtensions],
    status: s.status,
    messages: s.messages.map((msg) => ({
      ...msg,
      ...(msg.toolLogs ? { toolLogs: [...msg.toolLogs] } : {}),
      ...(msg.toolCalls
        ? { toolCalls: msg.toolCalls.map(cloneToolCall) }
        : {}),
    })),
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    streamingLogs: [...s.streamingLogs],
    streamingToolCalls: s.streamingToolCalls.map(cloneToolCall),
    pendingQuestion: s.pendingQuestionWaiter
      ? { ...s.pendingQuestionWaiter.question }
      : null,
    nextSteps: s.nextSteps.map((step) => ({ ...step })),
    todos: s.todoStore.getSnapshot(),
    backgroundCommands: s.bgCommandManager.list(),
    errorMessage: s.errorMessage,
    model,
    thinkingLevel: s.agentSession.thinkingLevel ?? "off",
    availableThinkingLevels,
    stats: buildStatsSnapshot(s.agentSession),
    skills: s.skills,
    mcpServers: buildMcpStatusList(s),
    updatedAt: s.updatedAt,
  };
}

async function resolveWorkbenchRepoDir(params: {
  sessionId: string;
  repoId?: string;
  customCwd?: string;
}): Promise<{
  cwd: string;
  isTempDir: boolean;
  repoId?: string;
  repoName?: string;
  repoUrl?: string;
}> {
  if (params.customCwd?.trim()) {
    const resolved = path.resolve(params.customCwd.trim());
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isDirectory()) {
      return {
        cwd: resolved,
        isTempDir: false,
        repoId: params.repoId,
        repoName: path.basename(resolved),
      };
    }
  }

  if (params.repoId) {
    const repos = await listCatalogRepos();
    const repo = repos.find((r) => r.id === params.repoId);
    if (repo) {
      const tmpDir = path.join(os.tmpdir(), "omp-workbench", params.sessionId);
      await fs.mkdir(tmpDir, { recursive: true });
      try {
        await execFileAsync(
          "git",
          ["clone", "--branch", repo.branch, "--depth", "1", repo.url, tmpDir],
          { timeout: 15_000 }
        );
      } catch {
        await fs.writeFile(
          path.join(tmpDir, "REPO_CONTEXT.md"),
          `# ${repo.name}\n\n- Repo ID: ${repo.id}\n- URL: ${repo.url}\n- Branch: ${repo.branch}\n`,
          "utf-8"
        );
      }
      return {
        cwd: tmpDir,
        isTempDir: true,
        repoId: repo.id,
        repoName: repo.name,
        repoUrl: repo.url,
      };
    }
  }

  return {
    cwd: process.cwd(),
    isTempDir: false,
  };
}

export async function createWorkbenchSession(params: {
  owner: string;
  repoId?: string;
  customCwd?: string;
  selectedMcps?: string[];
  disabledExtensions?: string[];
  openaiConfig?: OpenAIOverrideConfig;
  thinkingLevel?: string;
}): Promise<WorkbenchSessionSnapshot> {
  const sessionId = crypto.randomUUID();
  const owner = params.owner.trim() || "Admin";
  const selectedMcps = Array.isArray(params.selectedMcps)
    ? params.selectedMcps
    : [];
  const disabledExtensions = Array.isArray(params.disabledExtensions)
    ? params.disabledExtensions.filter(
        (id): id is string => typeof id === "string" && Boolean(id.trim())
      )
    : [];

  const repoInfo = await resolveWorkbenchRepoDir({
    sessionId,
    repoId: params.repoId,
    customCwd: params.customCwd,
  });

  const mcpServers = await getMcpServersByIdsForOwner(selectedMcps, owner);
  let mcpManager: MCPManager | undefined;
  const configuredMcps = mcpServers.map((srv) => ({
    id: srv.id,
    name: srv.name,
    url: srv.url,
  }));

  if (mcpServers.length > 0) {
    mcpManager = new MCPManager(repoInfo.cwd);
    const configs: Record<string, MCPServerConfig> = {};
    const sources: Record<
      string,
      { provider: string; providerName: string; path: string; level: "user" }
    > = {};
    for (const srv of mcpServers) {
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
    await mcpManager.connectServers(configs, sources as never).catch(() => {});
  }

  // Late-bound reference to the internal session once constructed
  let sessionRef: InternalWorkbenchSession | null = null;
  const touchSession = () => {
    if (sessionRef) {
      sessionRef.updatedAt = Date.now();
    }
  };

  const todoStore = new TodoSessionStore();
  const bgCommandManager = new BackgroundCommandManager(
    repoInfo.cwd,
    touchSession
  );

  const extBundle = buildWorkbenchExtensions(disabledExtensions, {
    sessionId,
    owner,
    cwd: repoInfo.cwd,
    selectedMcps,
    todoStore,
    bgCommandManager,
    setNextSteps(steps) {
      if (sessionRef) {
        sessionRef.nextSteps = steps;
        sessionRef.updatedAt = Date.now();
      }
    },
    onSkillSaved(skill) {
      if (!sessionRef) return;
      const idx = sessionRef.skills.findIndex((s) => s.name === skill.name);
      if (idx >= 0) {
        sessionRef.skills[idx] = skill;
      } else {
        sessionRef.skills.unshift(skill);
      }
      sessionRef.updatedAt = Date.now();
    },
    askUserQuestion(question, signal) {
      return new Promise<UserQuestionSubmission>((resolve) => {
        if (!sessionRef) {
          resolve({
            toolCallId: question.toolCallId,
            answers: [],
            cancelled: true,
          });
          return;
        }
        const targetCall = sessionRef.streamingToolCalls.find(
          (tc) => tc.toolCallId === question.toolCallId
        );
        if (targetCall) {
          targetCall.status = "waiting_input";
        }

        const finish = (submission: UserQuestionSubmission) => {
          if (
            sessionRef?.pendingQuestionWaiter?.question.toolCallId ===
            question.toolCallId
          ) {
            sessionRef.pendingQuestionWaiter = null;
          }
          if (targetCall && targetCall.status === "waiting_input") {
            targetCall.status = "running";
          }
          touchSession();
          resolve(submission);
        };

        if (signal?.aborted) {
          finish({
            toolCallId: question.toolCallId,
            answers: [],
            cancelled: true,
          });
          return;
        }

        const onAbort = () => {
          finish({
            toolCallId: question.toolCallId,
            answers: [],
            cancelled: true,
          });
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        sessionRef.pendingQuestionWaiter = {
          question,
          resolve: (submission) => {
            signal?.removeEventListener("abort", onAbort);
            finish(submission);
          },
        };
        touchSession();
      });
    },
    onStateChange: touchSession,
  });

  const { skills: discoveredSkills } = await discoverSkills(repoInfo.cwd);
  const hasOpenAIOverride = Boolean(
    params.openaiConfig?.apiKey?.trim() ||
      params.openaiConfig?.modelName?.trim() ||
      params.openaiConfig?.baseUrl?.trim()
  );
  const modelPattern = hasOpenAIOverride ? undefined : process.env.OMP_MODEL;
  const envModelOptions = !modelPattern
    ? await resolveOpenAIEnvSessionOptions(params.openaiConfig)
    : null;

  const { session: agentSession } = await createAgentSession({
    cwd: repoInfo.cwd,
    skills: discoveredSkills,
    ...(extBundle.factories.length > 0
      ? { extensions: extBundle.factories }
      : {}),
    ...(extBundle.appendSystemPrompt
      ? { appendSystemPrompt: extBundle.appendSystemPrompt }
      : {}),
    ...(mcpManager ? { mcpManager, enableMCP: true } : {}),
    sessionManager: SessionManager.inMemory(repoInfo.cwd),
    telemetry: buildSessionTelemetryConfig({
      operation: "workbench_chat",
      extraAttributes: {
        "workbench.session_id": sessionId,
        "repo.cwd": repoInfo.cwd,
      },
    }),
    ...(modelPattern ? { modelPattern } : {}),
    ...(envModelOptions ?? {}),
  });

  if (params.thinkingLevel) {
    try {
      agentSession.setThinkingLevel(params.thinkingLevel as never, false);
    } catch {
      // Ignore unsupported thinking level
    }
  }

  const skillsList: WorkbenchSkillItem[] = discoveredSkills.map((sk) => ({
    name: sk.name,
    description: sk.description,
    source: sk.source,
  }));

  const internal: InternalWorkbenchSession = {
    sessionId,
    owner,
    repoId: repoInfo.repoId,
    repoName: repoInfo.repoName,
    repoUrl: repoInfo.repoUrl,
    cwd: repoInfo.cwd,
    selectedMcps,
    enabledExtensions: extBundle.enabledIds,
    disabledExtensions,
    status: "idle",
    messages: [],
    streamingText: "",
    streamingThinking: "",
    streamingLogs: [],
    streamingToolCalls: [],
    pendingQuestionWaiter: null,
    nextSteps: [],
    todoStore,
    bgCommandManager,
    updatedAt: Date.now(),
    isTempDir: repoInfo.isTempDir,
    agentSession,
    mcpManager,
    skills: skillsList,
    configuredMcps,
  };
  sessionRef = internal;

  sessions.set(sessionId, internal);
  wbLog.info(
    {
      sessionId,
      owner,
      cwd: repoInfo.cwd,
      model: agentSession.model
        ? `${agentSession.model.provider}/${agentSession.model.id}`
        : undefined,
      enabledExtensions: extBundle.enabledIds,
      mcpCount: configuredMcps.length,
    },
    "Workbench session created"
  );
  return toSnapshot(internal);
}

export function getWorkbenchSession(
  sessionId: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  return s ? toSnapshot(s) : null;
}

export function listWorkbenchSessions(
  owner?: string
): WorkbenchSessionSnapshot[] {
  const normalizedOwner = owner?.trim();
  const list: WorkbenchSessionSnapshot[] = [];
  for (const s of sessions.values()) {
    if (!normalizedOwner || s.owner === normalizedOwner) {
      list.push(toSnapshot(s));
    }
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

export function setWorkbenchThinkingLevel(
  sessionId: string,
  level: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.agentSession.setThinkingLevel(level as never, false);
  s.updatedAt = Date.now();
  return toSnapshot(s);
}

export function submitWorkbenchQuestionAnswer(
  sessionId: string,
  submission: UserQuestionSubmission
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const waiter = s.pendingQuestionWaiter;
  if (!waiter) {
    throw new Error("当前没有等待回答的提问卡片");
  }
  if (
    submission.toolCallId &&
    submission.toolCallId !== waiter.question.toolCallId
  ) {
    throw new Error("提问卡片 ID 不匹配或已过期");
  }
  waiter.resolve({
    ...submission,
    toolCallId: waiter.question.toolCallId,
  });
  s.updatedAt = Date.now();
  return toSnapshot(s);
}

export function addWorkbenchUserTodo(
  sessionId: string,
  title: string,
  group?: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.todoStore.addItem({ title, origin: "user", group });
  s.updatedAt = Date.now();
  return toSnapshot(s);
}

export function removeWorkbenchTodo(
  sessionId: string,
  itemId: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.todoStore.removeItem(itemId);
  s.updatedAt = Date.now();
  return toSnapshot(s);
}

export function stopWorkbenchBackgroundCommand(
  sessionId: string,
  commandId: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.bgCommandManager.stop(commandId);
  s.updatedAt = Date.now();
  return toSnapshot(s);
}

export function sendWorkbenchMessage(
  sessionId: string,
  content: string
): WorkbenchSessionSnapshot | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.status === "running") {
    throw new Error("当前会话正在执行中，请等待完成或先中断当前轮次");
  }

  const userMsg: WorkbenchMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: content.trim(),
    createdAt: Date.now(),
  };
  s.messages.push(userMsg);
  s.status = "running";
  s.streamingText = "";
  s.streamingThinking = "";
  s.streamingLogs = [];
  s.streamingToolCalls = [];
  s.nextSteps = [];
  s.errorMessage = undefined;
  s.updatedAt = Date.now();

  let lastErrorMessage: string | undefined;
  const unsubscribe = s.agentSession.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        s.streamingText += event.assistantMessageEvent.delta;
        s.updatedAt = Date.now();
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        s.streamingThinking += event.assistantMessageEvent.delta;
        s.updatedAt = Date.now();
      }
    } else if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const argPath = typeof args.path === "string" ? args.path : "";
      const argCmd = typeof args.command === "string" ? args.command : "";
      const detail = argPath || (argCmd ? argCmd.slice(0, 80) : "");
      s.streamingLogs.push(
        `[工具] ${event.toolName}${detail ? `: ${detail}` : ""}`
      );
      s.streamingToolCalls.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: { ...args },
        status: "running",
        startedAt: Date.now(),
      });
      s.updatedAt = Date.now();
    } else if (event.type === "tool_execution_update") {
      const target = s.streamingToolCalls.find(
        (tc) => tc.toolCallId === event.toolCallId
      );
      if (target) {
        const partialText = extractToolResultText(event.partialResult);
        if (partialText) target.resultText = partialText;
        const partialDetails = extractToolDetails(event.partialResult);
        if (partialDetails) target.details = partialDetails;
        s.updatedAt = Date.now();
      }
    } else if (event.type === "tool_execution_end") {
      const target = s.streamingToolCalls.find(
        (tc) => tc.toolCallId === event.toolCallId
      );
      const endedAt = Date.now();
      const resultText = extractToolResultText(event.result);
      const details = extractToolDetails(event.result);
      const isError = Boolean(event.isError);
      if (target) {
        target.status = isError ? "error" : "completed";
        target.endedAt = endedAt;
        target.durationMs = Math.max(0, endedAt - target.startedAt);
        target.resultText = resultText;
        if (details) target.details = details;
        target.isError = isError;
      } else {
        s.streamingToolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: {},
          status: isError ? "error" : "completed",
          startedAt: endedAt,
          endedAt,
          durationMs: 0,
          resultText,
          ...(details ? { details } : {}),
          isError,
        });
      }
      wbLog.info(
        {
          sessionId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          durationMs: target?.durationMs ?? 0,
          isError,
        },
        isError ? "Workbench tool failed" : "Workbench tool finished"
      );
      s.updatedAt = Date.now();
    } else if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      lastErrorMessage =
        event.message.errorMessage || "Unknown AI provider error";
    }
  });

  void s.agentSession
    .prompt(userMsg.content)
    .then(() => {
      unsubscribe();
      const reply =
        s.streamingText.trim() ||
        (lastErrorMessage ? `错误：${lastErrorMessage}` : "（已完成操作）");
      s.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: reply,
        ...(s.streamingThinking.trim()
          ? { thinking: s.streamingThinking.trim() }
          : {}),
        toolLogs: s.streamingLogs.length > 0 ? [...s.streamingLogs] : undefined,
        toolCalls:
          s.streamingToolCalls.length > 0
            ? s.streamingToolCalls.map(cloneToolCall)
            : undefined,
        createdAt: Date.now(),
      });
      s.status = lastErrorMessage && !s.streamingText.trim() ? "error" : "idle";
      s.errorMessage = lastErrorMessage;
      s.streamingText = "";
      s.streamingThinking = "";
      s.streamingLogs = [];
      s.streamingToolCalls = [];
      s.updatedAt = Date.now();
    })
    .catch((err) => {
      unsubscribe();
      const msg = err instanceof Error ? err.message : String(err);
      s.status = "error";
      s.errorMessage = msg;
      s.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `执行失败：${msg}`,
        ...(s.streamingThinking.trim()
          ? { thinking: s.streamingThinking.trim() }
          : {}),
        toolLogs: s.streamingLogs.length > 0 ? [...s.streamingLogs] : undefined,
        toolCalls:
          s.streamingToolCalls.length > 0
            ? s.streamingToolCalls.map(cloneToolCall)
            : undefined,
        createdAt: Date.now(),
      });
      s.streamingText = "";
      s.streamingThinking = "";
      s.streamingLogs = [];
      s.streamingToolCalls = [];
      s.updatedAt = Date.now();
      wbLog.error(
        { sessionId, err },
        "Workbench message turn failed"
      );
    });

  return toSnapshot(s);
}

export async function abortWorkbenchSession(
  sessionId: string
): Promise<WorkbenchSessionSnapshot | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.pendingQuestionWaiter) {
    s.pendingQuestionWaiter.resolve({
      toolCallId: s.pendingQuestionWaiter.question.toolCallId,
      answers: [],
      cancelled: true,
    });
    s.pendingQuestionWaiter = null;
  }
  if (s.status === "running") {
    await s.agentSession
      .abort({ goalReason: "interrupted", reason: "Aborted by user" })
      .catch(() => {});
    s.status = "idle";
    s.updatedAt = Date.now();
  }
  return toSnapshot(s);
}

export async function closeWorkbenchSession(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  sessions.delete(sessionId);
  if (s.pendingQuestionWaiter) {
    s.pendingQuestionWaiter.resolve({
      toolCallId: s.pendingQuestionWaiter.question.toolCallId,
      answers: [],
      cancelled: true,
    });
    s.pendingQuestionWaiter = null;
  }
  s.bgCommandManager.dispose();
  await s.agentSession.dispose().catch(() => {});
  if (s.mcpManager) {
    await s.mcpManager.disconnectAll().catch(() => {});
  }
  if (s.isTempDir) {
    await fs.rm(s.cwd, { recursive: true, force: true }).catch(() => {});
  }
  wbLog.info({ sessionId }, "Workbench session closed");
  return true;
}
