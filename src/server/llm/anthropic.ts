import type { AiTask } from "../../shared/api.js";
import {
  LlmError,
  normalizeBaseUrl,
  retryAfter,
  unexpectedResponse,
  watchdog,
  type ChatEvent,
  type ChatRequest,
  type LlmConfig,
  type LlmProvider,
  type ModelInfo,
} from "./provider.js";

export const ANTHROPIC_VERSION = "2023-06-01";
/** D35: Claude's context length when the model list doesn't report one. */
export const ANTHROPIC_CONTEXT_LENGTH = 200_000;
/** D35: the output limit (`max_tokens`, required by Anthropic) for each task. */
export const MAX_OUTPUT_TOKENS: Record<AiTask, number> = {
  generate: 8_192,
  draft: 8_192,
  rewrite: 4_096,
  chat: 4_096,
};
/** The output limit when no task is named (a connection test). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
/** Pages of /v1/models to read at most (1,000 models each). */
const MAX_MODEL_PAGES = 5;

interface AnthropicError {
  type?: string;
  message?: string;
}

/** The error object of an Anthropic error body `{ type: "error", error: { type, message } }`. */
function parseError(text: string): AnthropicError {
  try {
    const body = JSON.parse(text) as { error?: AnthropicError };
    return body.error && typeof body.error === "object" ? body.error : {};
  } catch {
    return {};
  }
}

/**
 * Claude over the Messages API with plain fetch (D33): `GET /v1/models` and streamed
 * `POST /v1/messages`. System messages are lifted into the top-level `system` field; structured
 * output stays prompt plus zod validation (no response_format, D7).
 */
export class AnthropicProvider implements LlmProvider {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: LlmConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey ?? "";
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      accept: stream ? "text/event-stream" : "application/json",
      ...(stream ? { "content-type": "application/json" } : {}),
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  /** Maps an HTTP failure (or an error event) to an LlmError kind (api-contracts § Internal interfaces). */
  private failure(
    status: number | undefined,
    error: AnthropicError,
    model?: string,
    wait?: number,
  ): LlmError {
    const detail = error.message ? `: ${error.message.slice(0, 300)}` : "";
    const type = error.type ?? "";
    if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error")
      return new LlmError(
        "unauthorized",
        `${this.baseUrl} rejected the API key (${status ?? type}).`,
        status,
      );
    if (/credit balance/i.test(error.message ?? "") || type === "billing_error")
      return new LlmError(
        "no_credit",
        `${this.baseUrl} says the account has no credit left${detail}.`,
        status,
      );
    if (status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error")
      return new LlmError(
        "rate_limited",
        `${this.baseUrl} is ${status === 529 || type === "overloaded_error" ? "overloaded" : "limiting requests"} (${status ?? type}).`,
        status,
        wait,
      );
    if (/not a chat model/i.test(error.message ?? ""))
      return new LlmError(
        "model_not_found",
        `${model ?? "This model"} is not a chat model (${this.baseUrl}).`,
        status,
      );
    if ((status === 404 || type === "not_found_error") && model)
      return new LlmError("model_not_found", `Model ${model} isn't available at ${this.baseUrl}.`, status);
    return new LlmError("unreachable", `${this.baseUrl} answered ${status ?? type}${detail}.`, status);
  }

  private async statusError(response: Response, model?: string): Promise<LlmError> {
    const text = await response.text().catch(() => "");
    if (/html/i.test(response.headers.get("content-type") ?? ""))
      return unexpectedResponse(response, this.baseUrl, "json")!;
    return this.failure(response.status, parseError(text), model, retryAfter(response));
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const watch = watchdog(signal, this.timeoutMs, this.baseUrl);
    try {
      const models: ModelInfo[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const query = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
        const response = await fetch(`${this.baseUrl}/models?${query}`, {
          headers: this.headers(false),
          signal: watch.signal,
          redirect: "error",
        });
        if (!response.ok) throw await this.statusError(response);
        const unexpected = unexpectedResponse(response, this.baseUrl, "json");
        if (unexpected) throw unexpected;
        const body = (await response.json().catch(() => null)) as {
          data?: unknown;
          has_more?: unknown;
          last_id?: unknown;
        } | null;
        if (!body || !Array.isArray(body.data))
          throw new LlmError("unreachable", `${this.baseUrl}/models didn't return a model list.`);
        for (const item of body.data as {
          id?: unknown;
          max_input_tokens?: unknown;
          context_window?: unknown;
        }[]) {
          if (typeof item?.id !== "string") continue;
          const reported = [item.max_input_tokens, item.context_window].find(
            (value): value is number => typeof value === "number" && value > 0,
          );
          models.push({ id: item.id, contextLength: reported ?? ANTHROPIC_CONTEXT_LENGTH });
        }
        if (body.has_more !== true || typeof body.last_id !== "string") break;
        after = body.last_id;
      }
      return models;
    } catch (error) {
      throw watch.failure(error);
    } finally {
      watch.stop();
    }
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const watch = watchdog(request.signal, this.timeoutMs, this.baseUrl);
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map(({ role, content }) => ({ role, content }));
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(true),
        signal: watch.signal,
        redirect: "error",
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.task ? MAX_OUTPUT_TOKENS[request.task] : DEFAULT_MAX_OUTPUT_TOKENS,
          ...(system ? { system } : {}),
          messages,
          stream: true,
          // Claude's temperature runs 0–1; Studio's runs 0–2.
          ...(request.temperature != null ? { temperature: Math.min(1, request.temperature) } : {}),
        }),
      });
      if (!response.ok) throw await this.statusError(response, request.model);
      const unexpected = unexpectedResponse(response, this.baseUrl, "stream");
      if (unexpected) throw unexpected;
      if (!response.body) throw new LlmError("unreachable", `${this.baseUrl} sent no response body.`);

      watch.arm();
      const decoder = new TextDecoder();
      let buffer = "";
      let prompt: number | undefined;
      let completion: number | undefined;
      const done = (): ChatEvent => ({
        type: "done",
        ...(prompt != null || completion != null
          ? { usage: { prompt: prompt ?? 0, completion: completion ?? 0 } }
          : {}),
      });
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        watch.arm();
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue; // `event:` lines repeat the data's `type`.
          let event: {
            type?: string;
            message?: { usage?: Record<string, unknown> };
            delta?: { type?: string; text?: unknown };
            usage?: Record<string, unknown>;
            error?: AnthropicError;
          };
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          switch (event.type) {
            case "message_start": {
              const usage = event.message?.usage ?? {};
              // Cached input still counts as input.
              const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                .map((key) => usage[key])
                .filter((value): value is number => typeof value === "number");
              if (parts.length) prompt = parts.reduce((sum, value) => sum + value, 0);
              if (typeof usage.output_tokens === "number") completion = usage.output_tokens;
              break;
            }
            case "content_block_delta":
              if (
                event.delta?.type === "text_delta" &&
                typeof event.delta.text === "string" &&
                event.delta.text
              )
                yield { type: "delta", text: event.delta.text };
              break;
            case "message_delta":
              // output_tokens is cumulative: the last one counts.
              if (typeof event.usage?.output_tokens === "number") completion = event.usage.output_tokens;
              break;
            case "message_stop":
              yield done();
              return;
            case "error":
              throw this.failure(undefined, event.error ?? {}, request.model);
            default:
              break; // ping, content_block_start, content_block_stop
          }
        }
      }
      // The stream ended without message_stop: still finished.
      yield done();
    } catch (error) {
      throw watch.failure(error);
    } finally {
      watch.stop();
    }
  }
}
