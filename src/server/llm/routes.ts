import type { LlmModelsRequest, LlmTestRequest, LlmTestResponse, Usage } from "../../shared/api.js";
import { StudioError } from "../errors.js";
import { defaultProviderLabel } from "../providers.js";
import type { SettingsStore } from "../settings.js";
import { apiKeyHint, scrubKeys } from "./keys.js";
import { chatModels, type TargetKind } from "./models.js";
import { LlmError, normalizeBaseUrl, type LlmConfig, type LlmProvider } from "./provider.js";
import { fixedBaseUrl, providerFor } from "./target.js";

export type ProviderFactory = (config: LlmConfig) => LlmProvider;
export const defaultProviderFactory: ProviderFactory = (config) => providerFor(config);

/** The key for an unsaved connection: the request's (null = none), or the saved one when left out. */
function keyFor(request: { apiKey?: string | null }, store: SettingsStore): string | null {
  return request.apiKey === undefined ? (store.current().llm?.apiKey ?? null) : request.apiKey;
}

/** Who an error is about, for a paid provider: its label and its key (shown only as the hint). */
export interface FailureContext {
  label: string;
  apiKey: string | null;
}

/**
 * Maps an LlmError to the API's catalog; the message always names the base URL. With a provider
 * `context`, messages name the provider and show its key only as the hint (US-21).
 */
export function llmFailure(error: unknown, baseUrl: string, model?: string, context?: FailureContext): never {
  if (!(error instanceof LlmError)) throw error;
  const url = normalizeBaseUrl(baseUrl);
  const scrub = (text: string) => scrubKeys(text, [context?.apiKey]);
  const details = { detail: scrub(error.message) };
  const who = context ? `${context.label} (${url})` : url;
  switch (error.kind) {
    case "unauthorized":
      throw new StudioError(
        502,
        "LLM_UNAUTHORIZED",
        context?.apiKey
          ? `${who} rejected the API key ${apiKeyHint(context.apiKey)}.`
          : `${url} rejected the API key.`,
        { details },
      );
    case "model_not_found":
      throw new StudioError(
        502,
        "LLM_MODEL_NOT_FOUND",
        /not a chat model/i.test(error.message)
          ? scrub(error.message)
          : context
            ? `Model ${model ?? "?"} isn't available from ${who}.`
            : `Model ${model ?? "?"} isn't installed at ${url} — try \`ollama pull ${model ?? "<model>"}\`.`,
        { details },
      );
    case "timeout":
      throw new StudioError(504, "LLM_TIMEOUT", `${who}: the model stopped responding.`, { details });
    case "cancelled":
      throw new StudioError(409, "CANCELLED", "The request was cancelled.");
    case "rate_limited":
      throw new StudioError(
        502,
        "LLM_RATE_LIMITED",
        `${who} is limiting requests${error.retryAfterS != null ? ` — try again in ${error.retryAfterS} s` : ""}.`,
        { details: { ...details, ...(error.retryAfterS != null ? { retryAfterS: error.retryAfterS } : {}) } },
      );
    case "no_credit":
      throw new StudioError(
        502,
        "LLM_NO_CREDIT",
        context
          ? `Your ${context.label} account has no credit left.`
          : `${url} says the account has no credit left.`,
        { details },
      );
    default:
      throw new StudioError(
        502,
        "LLM_UNREACHABLE",
        context ? `Can't reach ${who}: ${scrub(error.message)}` : `Can't reach ${url} — is Ollama running?`,
        { details },
      );
  }
}

/** A request's target, resolved to where it goes and the key it carries. */
interface ResolvedTarget {
  kind: TargetKind;
  config: LlmConfig;
  /** Set for paid providers (saved or not). */
  context?: FailureContext;
}

/** Resolves one of the three target forms (api-contracts § Providers). */
function resolveTarget(request: LlmModelsRequest, store: SettingsStore, timeoutMs: number): ResolvedTarget {
  if ("providerId" in request && request.providerId) {
    const provider = store.current().providers?.find((item) => item.id === request.providerId);
    if (!provider)
      throw new StudioError(404, "PROVIDER_NOT_FOUND", `There's no provider "${request.providerId}".`);
    return {
      kind: provider.kind,
      config: { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey, timeoutMs },
      context: { label: provider.label, apiKey: provider.apiKey },
    };
  }
  if ("kind" in request && request.kind) {
    const baseUrl = request.kind === "openai-compatible" ? request.baseUrl! : fixedBaseUrl(request.kind);
    return {
      kind: request.kind,
      config: { kind: request.kind, baseUrl, apiKey: request.apiKey, timeoutMs },
      context: { label: defaultProviderLabel(request.kind, baseUrl), apiKey: request.apiKey },
    };
  }
  const local = request as { baseUrl: string; apiKey?: string | null };
  return {
    kind: "local",
    config: { kind: "local", baseUrl: local.baseUrl, apiKey: keyFor(local, store), timeoutMs },
  };
}

/** POST /api/llm/models: lists the chat models (D40) of a saved provider, an unsaved one, or a local server. */
export async function listModels(
  request: LlmModelsRequest,
  store: SettingsStore,
  factory: ProviderFactory,
  signal: AbortSignal,
) {
  const target = resolveTarget(request, store, 15_000);
  const provider = factory(target.config);
  try {
    return { models: chatModels(target.kind, await provider.listModels(signal)) };
  } catch (error) {
    llmFailure(error, target.config.baseUrl, undefined, target.context);
  }
}

export const TEST_PROMPT = "Reply with exactly one word: ready";

/** POST /api/llm/test: a fixed short prompt, its reply, how long it took and the tokens it used. */
export async function testConnection(
  request: LlmTestRequest,
  store: SettingsStore,
  factory: ProviderFactory,
  signal: AbortSignal,
): Promise<LlmTestResponse> {
  const timeoutMs = request.timeoutMs ?? store.current().llm?.timeoutMs ?? 60_000;
  const target = resolveTarget(request, store, timeoutMs);
  const provider = factory(target.config);
  const started = performance.now();
  try {
    let reply = "";
    let usage: Usage | null = null;
    for await (const event of provider.chat({
      model: request.model,
      messages: [{ role: "user", content: TEST_PROMPT }],
      temperature: 0,
      signal,
    })) {
      if (event.type === "delta") reply += event.text;
      else if (event.usage) usage = { input: event.usage.prompt, output: event.usage.completion };
    }
    return {
      reply: reply.trim().slice(0, 200),
      latencyMs: Math.round(performance.now() - started),
      usage,
    };
  } catch (error) {
    llmFailure(error, target.config.baseUrl, request.model, target.context);
  }
}
