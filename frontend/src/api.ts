export type SkillLifecycleStatus =
  | "draft"
  | "submitted"
  | "testing"
  | "test_passed"
  | "test_failed"
  | "published";

export interface RepoPipelineRun {
  repoId: string;
  repoName: string;
  repoUrl: string;
  status: "pending" | "running" | "success" | "failed";
  durationMs: number;
  logs: string[];
  jenkinsJobName?: string;
  jenkinsBuildNumber?: number;
  jenkinsBuildUrl?: string;
}

export type SkillFileCategory =
  | "skill_md"
  | "script"
  | "reference"
  | "asset"
  | "agent"
  | "eval"
  | "other";

export type SkillFileEncoding = "utf-8" | "base64";

export interface SkillResourceSummary {
  totalFiles: number;
  scripts: number;
  references: number;
  assets: number;
  agents: number;
  other: number;
}

export interface UserMcpServer {
  id: string;
  owner: string;
  name: string;
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCardRecord {
  skillName: string;
  description: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  currentStep: 1 | 2 | 3;
  progress: number;
  status: SkillLifecycleStatus;
  selectedApps: string[];
  selectedRepos: string[];
  selectedMcps?: string[];
  pipelineRuns: RepoPipelineRun[];
  frontmatter?: Record<string, unknown>;
  hasScripts?: boolean;
  resourceSummary?: SkillResourceSummary;
}

export interface SkillFileEntry {
  path: string;
  content: string;
  category?: SkillFileCategory;
  mimeType?: string;
  encoding?: SkillFileEncoding;
  sizeBytes?: number;
  isExecutable?: boolean;
}

export type GenerationJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export interface GenerationJobSnapshot {
  jobId: string;
  status: GenerationJobStatus;
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  timeoutMs: number;
  streamedContent: string;
  errorMessage?: string;
  result?: {
    card: SkillCardRecord;
    skillName: string;
    filePath: string;
    content: string;
    files: SkillFileEntry[];
  };
}

export interface AppCatalogItem {
  id: string;
  name: string;
  env: string;
}

export interface RepoCatalogItem {
  id: string;
  name: string;
  url: string;
  branch: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function fetchSkills(): Promise<{ skills: SkillCardRecord[] }> {
  return request("/api/skills");
}

export function fetchSkillDetail(
  skillName: string
): Promise<{ card: SkillCardRecord; content: string; files: SkillFileEntry[] }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}`);
}

export function generateSkill(payload: {
  skillName?: string;
  description?: string;
  creator?: string;
  prompt: string;
}): Promise<{
  card: SkillCardRecord;
  skillName: string;
  filePath: string;
  content: string;
  files: SkillFileEntry[];
}> {
  return request("/api/skills/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSkill(
  skillName: string,
  payload: {
    description?: string;
    creator?: string;
    content?: string;
    files?: SkillFileEntry[];
    replaceFiles?: boolean;
    deleteFile?: string;
    selectedMcps?: string[];
    submit?: boolean;
  }
): Promise<{ card: SkillCardRecord; content: string; files: SkillFileEntry[] }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getSkillDownloadUrl(skillName: string): string {
  return `/api/skills/${encodeURIComponent(skillName)}/download`;
}

export interface OpenAIOverrideConfig {
  apiKey?: string;
  modelName?: string;
  baseUrl?: string;
  apiMode?: "chat" | "responses";
}

export interface OpenAIModelItem {
  id: string;
  ownedBy?: string;
}

function parseOpenAIModelsPayload(payload: unknown): OpenAIModelItem[] {
  const rawList: unknown[] = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as unknown[])
      : payload &&
          typeof payload === "object" &&
          Array.isArray((payload as Record<string, unknown>).models)
        ? ((payload as Record<string, unknown>).models as unknown[])
        : [];

  const seen = new Set<string>();
  const models: OpenAIModelItem[] = [];
  for (const item of rawList) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push({ id });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = String(obj.id ?? obj.name ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy =
      typeof obj.owned_by === "string" && obj.owned_by.trim()
        ? obj.owned_by.trim()
        : undefined;
    models.push({ id, ...(ownedBy ? { ownedBy } : {}) });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function fetchOpenAIModels(payload: {
  baseUrl?: string;
  apiKey?: string;
  apiMode?: "chat" | "responses";
}): Promise<{ baseUrl: string; models: OpenAIModelItem[] }> {
  const apiKey = payload.apiKey?.trim() || "";
  const cleanBase = (payload.baseUrl?.trim() || "https://api.openai.com/v1").replace(
    /\/+$/,
    ""
  );

  // 1. Direct OpenAI protocol call: GET <baseUrl>/models with Bearer API Key
  if (apiKey && /^https?:\/\/.+/i.test(cleanBase)) {
    const endpoint = /\/models$/i.test(cleanBase)
      ? cleanBase
      : `${cleanBase}/models`;
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        const data = (await res.json()) as unknown;
        return {
          baseUrl: cleanBase,
          models: parseOpenAIModelsPayload(data),
        };
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("API Key 无效或无权限访问模型列表，请检查后重试");
      }
      throw new Error(
        `模型列表获取失败（HTTP ${res.status}），请检查 Base URL 是否正确或直接手动输入模型名`
      );
    } catch (directErr) {
      // Only fall back to backend proxy on network/CORS error (TypeError)
      if (!(directErr instanceof TypeError)) {
        throw directErr;
      }
    }
  }

  // 2. Fallback to backend proxy when CORS blocks direct browser call or using server .env key
  try {
    return await request("/api/openai/models", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      "未能自动获取可用模型列表，请检查 Base URL 与 API Key，或直接手动输入模型名"
    );
  }
}

export function startGenerationJob(payload: {
  skillName?: string;
  description?: string;
  creator?: string;
  selectedMcps?: string[];
  openaiConfig?: OpenAIOverrideConfig;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ job: GenerationJobSnapshot }> {
  return request("/api/skills/generate/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchUserMcps(
  owner: string
): Promise<{ mcps: UserMcpServer[] }> {
  return request(`/api/mcps?owner=${encodeURIComponent(owner)}`);
}

export function createUserMcp(payload: {
  owner: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  description?: string;
}): Promise<{ mcp: UserMcpServer }> {
  return request("/api/mcps", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteUserMcp(
  id: string,
  owner: string
): Promise<{ ok: boolean }> {
  return request(
    `/api/mcps/${encodeURIComponent(id)}?owner=${encodeURIComponent(owner)}`,
    { method: "DELETE" }
  );
}

export type WorkbenchExtensionId =
  | "ask-user-question"
  | "next-steps"
  | "todos"
  | "visualize"
  | "background-commands"
  | "skill-distiller";

export type ToolProminence = "routine" | "primary" | "interactive";

export interface WorkbenchExtensionDescriptor {
  id: WorkbenchExtensionId;
  title: string;
  description: string;
  toolNames: string[];
  defaultEnabled: boolean;
  prominence: ToolProminence;
}

export type WorkbenchToolCallStatus =
  | "running"
  | "waiting_input"
  | "completed"
  | "error";

export interface WorkbenchToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: WorkbenchToolCallStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  resultText?: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface UserQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
  recommendedReason?: string;
}

export interface UserQuestionItem {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  preview?: string;
  options: UserQuestionOption[];
}

export interface PendingUserQuestion {
  toolCallId: string;
  questions: UserQuestionItem[];
  createdAt: number;
}

export interface UserQuestionAnswerItem {
  questionId: string;
  selectedLabels: string[];
  otherText?: string;
  discussFirst?: boolean;
  discussNote?: string;
}

export interface UserQuestionSubmission {
  toolCallId: string;
  answers: UserQuestionAnswerItem[];
  cancelled?: boolean;
  chatInstead?: boolean;
}

export interface WorkbenchNextStep {
  label: string;
  prompt: string;
}

export type TodoItemStatus = "pending" | "in_progress" | "done";

export interface WorkbenchTodoItem {
  id: string;
  title: string;
  status: TodoItemStatus;
  origin: "agent" | "user";
  note?: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkbenchTodoGroup {
  id: string;
  title: string;
  status: "pending" | "active" | "done";
  items: WorkbenchTodoItem[];
}

export interface WorkbenchTodoState {
  groups: WorkbenchTodoGroup[];
  loose: WorkbenchTodoItem[];
  summary?: string;
  updatedAt: number;
}

export type BackgroundCommandStatus =
  | "running"
  | "stopping"
  | "completed"
  | "error"
  | "stopped";

export interface WorkbenchBackgroundCommandSnapshot {
  id: string;
  name: string;
  command: string;
  status: BackgroundCommandStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  outputPreview: string;
  outputTruncated: boolean;
  outputLines: number;
  errorMessage?: string;
}

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

export function fetchWorkbenchExtensions(): Promise<{
  extensions: WorkbenchExtensionDescriptor[];
}> {
  return request("/api/workbench/extensions");
}

export function fetchWorkbenchSessions(
  owner?: string
): Promise<{ sessions: WorkbenchSessionSnapshot[] }> {
  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  return request(`/api/workbench/sessions${qs}`);
}

export function createWorkbenchSession(payload: {
  owner: string;
  repoId?: string;
  customCwd?: string;
  selectedMcps?: string[];
  disabledExtensions?: string[];
  openaiConfig?: OpenAIOverrideConfig;
  thinkingLevel?: string;
}): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request("/api/workbench/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitWorkbenchQuestionAnswer(
  sessionId: string,
  payload: UserQuestionSubmission
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/question/answer`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function addWorkbenchTodo(
  sessionId: string,
  payload: { title: string; group?: string }
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/todos`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function removeWorkbenchTodo(
  sessionId: string,
  itemId: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/todos/${encodeURIComponent(itemId)}`,
    { method: "DELETE" }
  );
}

export function stopWorkbenchBgCommand(
  sessionId: string,
  commandId: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/bg-commands/${encodeURIComponent(commandId)}/stop`,
    { method: "POST" }
  );
}

export function setWorkbenchThinking(
  sessionId: string,
  thinkingLevel: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/thinking`,
    {
      method: "POST",
      body: JSON.stringify({ thinkingLevel }),
    }
  );
}

export function fetchWorkbenchSession(
  sessionId: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(`/api/workbench/sessions/${encodeURIComponent(sessionId)}`);
}

export function sendWorkbenchMessage(
  sessionId: string,
  message: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ message }),
    }
  );
}

export function abortWorkbenchSession(
  sessionId: string
): Promise<{ session: WorkbenchSessionSnapshot }> {
  return request(
    `/api/workbench/sessions/${encodeURIComponent(sessionId)}/abort`,
    { method: "POST" }
  );
}

export function closeWorkbenchSession(
  sessionId: string
): Promise<{ ok: boolean }> {
  return request(`/api/workbench/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function fetchGenerationJob(
  jobId: string
): Promise<{ job: GenerationJobSnapshot }> {
  return request(`/api/skills/generate/jobs/${encodeURIComponent(jobId)}`);
}

export function abortGenerationJob(
  jobId: string,
  reason?: string
): Promise<{ job: GenerationJobSnapshot }> {
  return request(`/api/skills/generate/jobs/${encodeURIComponent(jobId)}/abort`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function restartGenerationJob(
  jobId: string,
  payload?: { prompt?: string; timeoutMs?: number }
): Promise<{ job: GenerationJobSnapshot }> {
  return request(
    `/api/skills/generate/jobs/${encodeURIComponent(jobId)}/restart`,
    {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }
  );
}

export function fetchCatalog(): Promise<{
  apps: AppCatalogItem[];
  repos: RepoCatalogItem[];
}> {
  return request("/api/catalog");
}

export function runTestPipeline(
  skillName: string,
  payload: { apps: string[]; repos: string[]; mode: "simulate" | "real" | "jenkins" }
): Promise<{
  card: SkillCardRecord;
  allPassed: boolean;
  pipelineRuns: RepoPipelineRun[];
}> {
  return request(
    `/api/skills/${encodeURIComponent(skillName)}/test-pipeline`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

export function publishSkill(
  skillName: string
): Promise<{ card: SkillCardRecord }> {
  return request(`/api/skills/${encodeURIComponent(skillName)}/publish`, {
    method: "POST",
  });
}
