import {
  discoverAuthStorage,
  ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";

export type OpenAIApiMode = "chat" | "responses";

export interface OpenAIOverrideConfig {
  apiKey?: string;
  modelName?: string;
  baseUrl?: string;
  apiMode?: OpenAIApiMode;
}

export interface EnvSessionModelOptions {
  authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>;
  modelRegistry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
}

const PLACEHOLDER_KEY = "sk-your-api-key-here";
const ENV_PROVIDER_NAME = "openai-env";

export interface OpenAIModelItem {
  id: string;
  ownedBy?: string;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function buildModelsEndpoint(baseUrl: string): string {
  const clean = normalizeBaseUrl(baseUrl);
  if (/\/models$/i.test(clean)) return clean;
  return `${clean}/models`;
}

/**
 * Fetch available models from an OpenAI-compatible `/models` endpoint.
 */
export async function fetchOpenAIAvailableModels(params: {
  baseUrl?: string;
  apiKey?: string;
  apiMode?: OpenAIApiMode;
}): Promise<{ baseUrl: string; models: OpenAIModelItem[] }> {
  const mode: OpenAIApiMode =
    params.apiMode === "responses" ? "responses" : "chat";
  const modeKey =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_API_KEY
      : process.env.OPENAI_CHAT_API_KEY;
  const apiKey =
    params.apiKey?.trim() ||
    modeKey?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";

  if (!apiKey || apiKey === PLACEHOLDER_KEY) {
    throw new Error("请先填写有效的 API Key");
  }

  const modeBaseUrl =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_BASE_URL
      : process.env.OPENAI_CHAT_BASE_URL;
  const baseUrl = normalizeBaseUrl(
    params.baseUrl?.trim() ||
      modeBaseUrl?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
  );

  if (!/^https?:\/\/.+/i.test(baseUrl)) {
    throw new Error("Base URL 必须以 http:// 或 https:// 开头");
  }

  const endpoint = buildModelsEndpoint(baseUrl);
  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const snippet = errBody.trim().slice(0, 200);
    throw new Error(
      `拉取 /models 失败 (HTTP ${res.status})${snippet ? `: ${snippet}` : ""}`
    );
  }

  const payload = (await res.json()) as unknown;
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
  return { baseUrl, models };
}

/**
 * Resolve OpenAI-compatible model configuration from environment variables (.env)
 * and/or per-request user overrides (custom API key, model, baseUrl, apiMode).
 */
export async function resolveOpenAIEnvSessionOptions(
  override?: OpenAIOverrideConfig
): Promise<EnvSessionModelOptions | null> {
  const rawMode = (
    override?.apiMode ||
    process.env.OPENAI_API_MODE ||
    "chat"
  )
    .trim()
    .toLowerCase();
  const mode: OpenAIApiMode =
    rawMode === "responses" || rawMode === "openai-responses"
      ? "responses"
      : "chat";

  const api = mode === "responses" ? "openai-responses" : "openai-completions";

  const modeKey =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_API_KEY
      : process.env.OPENAI_CHAT_API_KEY;
  const apiKey =
    override?.apiKey?.trim() ||
    modeKey?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";

  if (!apiKey || apiKey === PLACEHOLDER_KEY) {
    return null;
  }

  const modeBaseUrl =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_BASE_URL
      : process.env.OPENAI_CHAT_BASE_URL;
  const baseUrl = normalizeBaseUrl(
    override?.baseUrl?.trim() ||
      modeBaseUrl?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
  );

  const modeModelName =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_MODEL_NAME
      : process.env.OPENAI_CHAT_MODEL_NAME;
  const modelName =
    override?.modelName?.trim() ||
    modeModelName?.trim() ||
    process.env.OPENAI_MODEL_NAME?.trim() ||
    (mode === "responses" ? "gpt-4.1" : "gpt-4o");

  const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW) || 128000;
  const maxTokens = Number(process.env.OPENAI_MAX_TOKENS) || 16384;

  const authStorage = await discoverAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  modelRegistry.registerProvider(ENV_PROVIDER_NAME, {
    baseUrl,
    apiKey,
    api,
    authHeader: true,
    models: [
      {
        id: modelName,
        name: modelName,
        api,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow,
        maxTokens,
      },
    ],
  });

  const model = modelRegistry.find(ENV_PROVIDER_NAME, modelName);
  if (!model) {
    throw new Error(
      `Failed to register OpenAI env model "${modelName}" (${api}) at ${baseUrl}`
    );
  }

  return {
    authStorage,
    modelRegistry,
    model,
  };
}
