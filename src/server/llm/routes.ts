import type { LlmModelsRequest, LlmTestRequest, LlmTestResponse } from "../../shared/api.js";
import { StudioError } from "../errors.js";
import type { SettingsStore } from "../settings.js";
import {
  LlmError,
  OpenAiCompatibleProvider,
  chatText,
  normalizeBaseUrl,
  type LlmConfig,
  type LlmProvider,
} from "./provider.js";

export type ProviderFactory = (config: LlmConfig) => LlmProvider;
export const defaultProviderFactory: ProviderFactory = (config) => new OpenAiCompatibleProvider(config);

/** The key for an unsaved connection: the request's (null = none), or the saved one when left out. */
function keyFor(request: { apiKey?: string | null }, store: SettingsStore): string | null {
  return request.apiKey === undefined ? (store.current().llm?.apiKey ?? null) : request.apiKey;
}

/** Maps an LlmError to the API's catalog; the message always names the base URL. */
export function llmFailure(error: unknown, baseUrl: string, model?: string): never {
  if (!(error instanceof LlmError)) throw error;
  const url = normalizeBaseUrl(baseUrl);
  switch (error.kind) {
    case "unauthorized":
      throw new StudioError(502, "LLM_UNAUTHORIZED", `${url} rejected the API key.`, {
        details: { detail: error.message },
      });
    case "model_not_found":
      throw new StudioError(
        502,
        "LLM_MODEL_NOT_FOUND",
        `Model ${model ?? "?"} isn't installed at ${url} — try \`ollama pull ${model ?? "<model>"}\`.`,
        {
          details: { detail: error.message },
        },
      );
    case "timeout":
      throw new StudioError(504, "LLM_TIMEOUT", `${url}: the model stopped responding.`, {
        details: { detail: error.message },
      });
    case "cancelled":
      throw new StudioError(409, "CANCELLED", "The request was cancelled.");
    default:
      throw new StudioError(502, "LLM_UNREACHABLE", `Can't reach ${url} — is Ollama running?`, {
        details: { detail: error.message },
      });
  }
}

/** POST /api/llm/models: lists models for an unsaved base URL. */
export async function listModels(
  request: LlmModelsRequest,
  store: SettingsStore,
  factory: ProviderFactory,
  signal: AbortSignal,
) {
  const provider = factory({ baseUrl: request.baseUrl, apiKey: keyFor(request, store), timeoutMs: 15_000 });
  try {
    return { models: await provider.listModels(signal) };
  } catch (error) {
    llmFailure(error, request.baseUrl);
  }
}

export const TEST_PROMPT = "Reply with exactly one word: ready";

/** POST /api/llm/test: a fixed short prompt, its reply and how long it took. */
export async function testConnection(
  request: LlmTestRequest,
  store: SettingsStore,
  factory: ProviderFactory,
  signal: AbortSignal,
): Promise<LlmTestResponse> {
  const timeoutMs = request.timeoutMs ?? store.current().llm?.timeoutMs ?? 60_000;
  const provider = factory({ baseUrl: request.baseUrl, apiKey: keyFor(request, store), timeoutMs });
  const started = performance.now();
  try {
    const reply = await chatText(provider, {
      model: request.model,
      messages: [{ role: "user", content: TEST_PROMPT }],
      temperature: 0,
      signal,
    });
    return { reply: reply.trim().slice(0, 200), latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    llmFailure(error, request.baseUrl, request.model);
  }
}
