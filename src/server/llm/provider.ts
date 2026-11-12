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
  signal: AbortSignal;
}
/** The LLM seam every AI feature uses (tech-spec: api-contracts § Internal interfaces). */
export interface LlmProvider {
  listModels(signal: AbortSignal): Promise<{ id: string; contextLength?: number }[]>;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
}
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string | null;
  /** No response or token for this long throws LlmError("timeout"). */
  timeoutMs?: number;
}

export type LlmErrorKind = "unreachable" | "timeout" | "unauthorized" | "model_not_found" | "cancelled";

/** A typed LLM failure. `message` names the base URL. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
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

  /** A controller aborted by the caller's signal or, after `timeoutMs` without activity, by a timeout. */
  private watchdog(signal: AbortSignal) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
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
            `${this.baseUrl} stopped responding (no data for ${Math.round(this.timeoutMs / 1000)} s).`,
          );
        if (signal.aborted) return new LlmError("cancelled", "The request was cancelled.");
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        const detail = code && NETWORK_CODES.has(code) ? code : (error as Error)?.message;
        return new LlmError("unreachable", `Can't reach ${this.baseUrl} (${detail}).`);
      },
    };
  }

  private async statusError(response: Response, model?: string): Promise<LlmError> {
    const body = (await response.text().catch(() => "")).slice(0, 300);
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
      });
      if (!response.ok) throw await this.statusError(response);
      const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (!body || !Array.isArray(body.data))
        throw new LlmError("unreachable", `${this.baseUrl}/models didn't return an OpenAI model list.`);
      return body.data
        .filter((item): item is { id: string; context_length?: unknown } => typeof item?.id === "string")
        .map((item) => ({
          id: item.id,
          ...(typeof item.context_length === "number" ? { contextLength: item.context_length } : {}),
        }));
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
      const send = (withFormat: boolean) =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(false),
          signal: watch.signal,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: true,
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
      const withFormat = Boolean(request.jsonSchema) && !noResponseFormat.has(memory);
      let response = await send(withFormat);
      if (withFormat && response.status === 400) {
        const body = await response.text().catch(() => "");
        if (!/response_format|json_schema/i.test(body)) {
          throw new LlmError("unreachable", `${this.baseUrl} answered 400: ${body.slice(0, 300)}.`, 400);
        }
        // This server doesn't do structured output: remember, and retry once without it.
        noResponseFormat.add(memory);
        response = await send(false);
      }
      if (!response.ok) throw await this.statusError(response, request.model);
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

/** Collects a chat's text. */
export async function chatText(provider: LlmProvider, request: ChatRequest): Promise<string> {
  let text = "";
  for await (const event of provider.chat(request)) if (event.type === "delta") text += event.text;
  return text;
}
