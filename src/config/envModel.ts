import {
  discoverAuthStorage,
  ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";

export type OpenAIApiMode = "chat" | "responses";

export interface EnvSessionModelOptions {
  authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>;
  modelRegistry: ModelRegistry;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
}

const PLACEHOLDER_KEY = "sk-your-api-key-here";
const ENV_PROVIDER_NAME = "openai-env";

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Resolve OpenAI-compatible model configuration from environment variables (.env).
 * Supports both Chat Completions API (`openai-completions`) and Responses API (`openai-responses`).
 */
export async function resolveOpenAIEnvSessionOptions(): Promise<EnvSessionModelOptions | null> {
  const rawMode = (process.env.OPENAI_API_MODE || "chat").trim().toLowerCase();
  const mode: OpenAIApiMode =
    rawMode === "responses" || rawMode === "openai-responses"
      ? "responses"
      : "chat";

  const api = mode === "responses" ? "openai-responses" : "openai-completions";

  const modeKey =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_API_KEY
      : process.env.OPENAI_CHAT_API_KEY;
  const apiKey = modeKey?.trim() || process.env.OPENAI_API_KEY?.trim() || "";

  if (!apiKey || apiKey === PLACEHOLDER_KEY) {
    return null;
  }

  const modeBaseUrl =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_BASE_URL
      : process.env.OPENAI_CHAT_BASE_URL;
  const baseUrl = normalizeBaseUrl(
    modeBaseUrl?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1"
  );

  const modeModelName =
    mode === "responses"
      ? process.env.OPENAI_RESPONSES_MODEL_NAME
      : process.env.OPENAI_CHAT_MODEL_NAME;
  const modelName =
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
