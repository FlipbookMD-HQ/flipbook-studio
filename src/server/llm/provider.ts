import type { AiTask, ProviderKind } from "../../shared/api.js";

/** A chat message in the OpenAI format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export type ChatEvent =
  { type: "delta"; text: string } | { type: "done"; usage?: { prompt: number; completion: number } };
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Sent as response_format when the server supports it. Callers validate the output anyway. */
  jsonSchema?: object;
  /** The AI task asking, which sets the output limit where a provider needs one (D35). */
  task?: AiTask;
  signal: AbortSignal;
}
/**
 * A listed model. The capability fields are what the server reported, for the chat filter (D40);
 * they never reach the API response.
 */
export interface ModelInfo {
  id: string;
  contextLength?: number;
  /** OpenRouter's `architecture.input_modalities` / `output_modalities`. */
  modalities?: { input: string[]; output: string[] };
  /** A server's `capabilities` list (or the true keys of a capabilities object). */
  capabilities?: string[];
}
/** The LLM seam every AI feature uses (tech-spec: api-contracts § Internal interfaces). */
export interface LlmProvider {
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
}
export interface LlmConfig {
  /** Which adapter (US-21): "local" or left out is the local OpenAI-compatible server. */
  kind?: "local" | ProviderKind;
  baseUrl: string;
  apiKey?: string | null;
  /** No response or token for this long throws LlmError("timeout"). */
  timeoutMs?: number;
}

export type LlmErrorKind =
  "unreachable" | "timeout" | "unauthorized" | "model_not_found" | "cancelled" | "rate_limited" | "no_credit";

/** A typed LLM failure. `message` names the base URL and never contains a key. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    /** For rate_limited: the provider's `retry-after`, in seconds, when it sent one. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** The base URL with exactly one trailing `/v1` and no trailing slash. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Base URL + model pairs whose server rejected response_format; later calls skip it.
const noResponseFormat = new Set<string>();

/** For tests: forget which servers reject response_format. */
export function resetResponseFormatMemory() {
  noResponseFormat.clear();
}

/** For tests: forget which servers reject stream_options. */
export function resetStreamOptionsMemory() {
  noStreamOptions.clear();
}
// Base URLs whose server rejected stream_options.include_usage; later calls skip it (US-21).
const noStreamOptions = new Set<string>();

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

/**
 * A controller aborted by the caller's signal or, after `timeoutMs` without activity, by a timeout.
 * `failure` turns whatever was thrown into an LlmError naming `baseUrl`. Shared by every adapter.
 */
export function watchdog(signal: AbortSignal, timeoutMs: number, baseUrl: string) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    arm,
    stop: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
    failure: (error: unknown): LlmError => {
      if (error instanceof LlmError) return error;
      if (timedOut)
        return new LlmError(
          "timeout",
          `${baseUrl} stopped responding (no data for ${Math.round(timeoutMs / 1000)} s).`,
        );
      if (signal.aborted) return new LlmError("cancelled", "The request was cancelled.");
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      // fetch(..., { redirect: "error" }) refuses any redirect, so a key never follows one to another host.
      if (/redirect/i.test(cause?.message ?? ""))
        return new LlmError(
          "unreachable",
          `${baseUrl} answered with a redirect, which Studio doesn't follow.`,
        );
      const code = cause?.code;
      const detail = code && NETWORK_CODES.has(code) ? code : (error as Error)?.message;
      return new LlmError("unreachable", `Can't reach ${baseUrl} (${detail}).`);
    },
  };
}

/** The host of a URL, for messages. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A 2xx answer that isn't the API (a captive portal or proxy page): unreachable, naming the host.
 * `expect` is the content type the API sends.
 */
export function unexpectedResponse(
  response: Response,
  baseUrl: string,
  expect: "json" | "stream",
): LlmError | null {
  const type = response.headers.get("content-type") ?? "";
  const ok = expect === "json" ? /json/i.test(type) : /event-stream|json/i.test(type);
  if (ok || (!type && expect === "stream")) return null;
  return new LlmError(
    "unreachable",
    `Unexpected response from ${hostOf(baseUrl)} (${type.split(";")[0] || "no content type"}, not the API).`,
    response.status,
  );
}

/** `retry-after` in seconds (a number of seconds or an HTTP date), when sent. */
export function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** The first adapter (D6): any OpenAI-compatible HTTP server (Ollama, LM Studio, llama.cpp). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(config: LlmConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey || null;
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      accept: json ? "application/json" : "text/event-stream",
      ...(json ? {} : { "content-type": "application/json" }),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private watchdog(signal: AbortSignal) {
    return watchdog(signal, this.timeoutMs, this.baseUrl);
  }

  private async statusError(response: Response, model?: string): Promise<LlmError> {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    // US-21: quota and rate limits. OpenAI sends insufficient_quota on a 429; OpenRouter uses 402.
    if (response.status === 402 || (response.status === 429 && /insufficient_quota/i.test(body)))
      return new LlmError(
        "no_credit",
        `${this.baseUrl} says the account has no credit left.`,
        response.status,
      );
    if (response.status === 429)
      return new LlmError(
        "rate_limited",
        `${this.baseUrl} is limiting requests (429).`,
        429,
        retryAfter(response),
      );
    if (model && /not a chat model/i.test(body))
      return new LlmError(
        "model_not_found",
        `${model} is not a chat model (${this.baseUrl}).`,
        response.status,
      );
    if (response.status === 401 || response.status === 403)
      return new LlmError(
        "unauthorized",
        `${this.baseUrl} rejected the API key (${response.status}).`,
        response.status,
      );
    if (response.status === 404 && model)
      return new LlmError("model_not_found", `Model ${model} isn't available at ${this.baseUrl}.`, 404);
    return new LlmError(
      "unreachable",
      `${this.baseUrl} answered ${response.status}${body ? `: ${body}` : ""}.`,
      response.status,
    );
  }

  async listModels(signal: AbortSignal) {
    const watch = this.watchdog(signal);
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(true),
        signal: watch.signal,
        redirect: "error",
      });
      if (!response.ok) throw await this.statusError(response);
      const unexpected = /html/i.test(response.headers.get("content-type") ?? "")
        ? unexpectedResponse(response, this.baseUrl, "json")
        : null;
      if (unexpected) throw unexpected;
      const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (!body || !Array.isArray(body.data))
        throw new LlmError("unreachable", `${this.baseUrl}/models didn't return an OpenAI model list.`);
      return body.data
        .filter((item): item is OpenAiModelEntry => typeof item?.id === "string")
        .map(openAiModelInfo);
    } catch (error) {
      throw watch.failure(error);
    } finally {
      watch.stop();
    }
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const memory = `${this.baseUrl}|${request.model}`;
    const watch = this.watchdog(request.signal);
    try {
      let withUsage = !noStreamOptions.has(this.baseUrl);
      const send = (withFormat: boolean) =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(false),
          signal: watch.signal,
          redirect: "error",
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: true,
            // US-21: ask for token usage in the last chunk; a server that rejects it is remembered.
            ...(withUsage ? { stream_options: { include_usage: true } } : {}),
            ...(request.temperature != null ? { temperature: request.temperature } : {}),
            ...(withFormat
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: { name: "output", strict: true, schema: request.jsonSchema },
                  },
                }
              : {}),
          }),
        });
      let withFormat = Boolean(request.jsonSchema) && !noResponseFormat.has(memory);
      let response = await send(withFormat);
      // A 400 for an option the server doesn't know: remember, and retry once without it.
      for (let retries = 0; response.status === 400 && retries < 2; retries++) {
        const body = await response.text().catch(() => "");
        if (withFormat && /response_format|json_schema/i.test(body)) {
          // This server doesn't do structured output.
          noResponseFormat.add(memory);
          withFormat = false;
        } else if (withUsage && /stream_options|include_usage/i.test(body)) {
          noStreamOptions.add(this.baseUrl);
          withUsage = false;
        } else {
          if (/not a chat model/i.test(body))
            throw new LlmError(
              "model_not_found",
              `${request.model} is not a chat model (${this.baseUrl}).`,
              400,
            );
          throw new LlmError("unreachable", `${this.baseUrl} answered 400: ${body.slice(0, 300)}.`, 400);
        }
        response = await send(withFormat);
      }
      if (!response.ok) throw await this.statusError(response, request.model);
      const unexpected = unexpectedResponse(response, this.baseUrl, "stream");
      if (unexpected) throw unexpected;
      if (!response.body) throw new LlmError("unreachable", `${this.baseUrl} sent no response body.`);

      watch.arm();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage: { prompt: number; completion: number } | undefined;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        watch.arm();
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            yield { type: "done", ...(usage ? { usage } : {}) };
            return;
          }
          let event: {
            choices?: { delta?: { content?: unknown } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            event = JSON.parse(data);
          } catch {
            continue; // A keep-alive or a partial line from a non-conforming server.
          }
          const text = event.choices?.[0]?.delta?.content;
          if (typeof text === "string" && text) yield { type: "delta", text };
          if (event.usage && typeof event.usage.prompt_tokens === "number")
            usage = { prompt: event.usage.prompt_tokens, completion: event.usage.completion_tokens ?? 0 };
        }
      }
      // The stream ended without [DONE]: still finished.
      yield { type: "done", ...(usage ? { usage } : {}) };
    } catch (error) {
      throw watch.failure(error);
    } finally {
      watch.stop();
    }
  }
}

interface OpenAiModelEntry {
  id: string;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  capabilities?: unknown;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;

/** A /models entry with the fields the chat filter (D40) and the context budget use. */
function openAiModelInfo(item: OpenAiModelEntry): ModelInfo {
  const input = strings(item.architecture?.input_modalities);
  const output = strings(item.architecture?.output_modalities);
  const capabilities =
    strings(item.capabilities) ??
    (item.capabilities && typeof item.capabilities === "object"
      ? Object.entries(item.capabilities as Record<string, unknown>)
          .filter(([, on]) => on === true)
          .map(([name]) => name)
      : null);
  return {
    id: item.id,
    ...(typeof item.context_length === "number" ? { contextLength: item.context_length } : {}),
    ...(input && output ? { modalities: { input, output } } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

/** Collects a chat's text. */
export async function chatText(provider: LlmProvider, request: ChatRequest): Promise<string> {
  let text = "";
  for await (const event of provider.chat(request)) if (event.type === "delta") text += event.text;
  return text;
}
