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
import { buildSessionTelemetryConfig } from "../config/telemetry.js";
import { getMcpServersByIdsForOwner } from "../repositories/mcpRepository.js";
import { listCatalogRepos } from "../repositories/skillRepository.js";

const execFileAsync = promisify(execFile);

export interface WorkbenchMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  toolLogs?: string[];
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
  status: "idle" | "running" | "error";
  messages: WorkbenchMessage[];
  streamingText: string;
  streamingThinking: string;
  streamingLogs: string[];
  errorMessage?: string;
  model: WorkbenchModelInfo | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  stats: WorkbenchSessionStats;
  skills: WorkbenchSkillItem[];
  mcpServers: WorkbenchMcpStatusItem[];
  updatedAt: number;
}

interface InternalWorkbenchSession {
  sessionId: string;
  owner: string;
  repoId?: string;
  repoName?: string;
  repoUrl?: string;
  cwd: string;
  selectedMcps: string[];
  status: "idle" | "running" | "error";
  messages: WorkbenchMessage[];
  streamingText: string;
  streamingThinking: string;
  streamingLogs: string[];
  errorMessage?: string;
  updatedAt: number;
  isTempDir: boolean;
  agentSession: AgentSession;
  mcpManager?: MCPManager;
  skills: WorkbenchSkillItem[];
  configuredMcps: Array<{ id: string; name: string; url: string }>;
}

const sessions = new Map<string, InternalWorkbenchSession>();

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
    status: s.status,
    messages: s.messages.map((msg) => ({ ...msg })),
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    streamingLogs: [...s.streamingLogs],
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
        // Fallback workspace when demo repo URL is unreachable
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
  openaiConfig?: OpenAIOverrideConfig;
  thinkingLevel?: string;
}): Promise<WorkbenchSessionSnapshot> {
  const sessionId = crypto.randomUUID();
  const owner = params.owner.trim() || "Admin";
  const selectedMcps = Array.isArray(params.selectedMcps)
    ? params.selectedMcps
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
    status: "idle",
    messages: [],
    streamingText: "",
    streamingThinking: "",
    streamingLogs: [],
    updatedAt: Date.now(),
    isTempDir: repoInfo.isTempDir,
    agentSession,
    mcpManager,
    skills: skillsList,
    configuredMcps,
  };

  sessions.set(sessionId, internal);
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
        createdAt: Date.now(),
      });
      s.status = lastErrorMessage && !s.streamingText.trim() ? "error" : "idle";
      s.errorMessage = lastErrorMessage;
      s.streamingText = "";
      s.streamingThinking = "";
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
        createdAt: Date.now(),
      });
      s.streamingText = "";
      s.streamingThinking = "";
      s.updatedAt = Date.now();
    });

  return toSnapshot(s);
}

export async function abortWorkbenchSession(
  sessionId: string
): Promise<WorkbenchSessionSnapshot | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
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
  await s.agentSession.dispose().catch(() => {});
  if (s.mcpManager) {
    await s.mcpManager.disconnectAll().catch(() => {});
  }
  if (s.isTempDir) {
    await fs.rm(s.cwd, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}
