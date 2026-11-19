import type { ApiError } from "../../shared/api.js";
import { StudioError } from "../errors.js";
import { LlmError } from "../llm/provider.js";
import { llmFailure } from "../llm/routes.js";

export interface SseContext {
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  send(event: string, data: unknown): void;
}

/** Maps any failure to the API error a `failed` event carries (LLM errors as /api/llm/test maps them). */
export function aiError(error: unknown, baseUrl?: string, model?: string): ApiError {
  if (error instanceof StudioError) return error.toJSON();
  if (error instanceof LlmError) {
    if (error.kind === "cancelled") return { code: "CANCELLED", message: "Cancelled." };
    try {
      llmFailure(error, baseUrl ?? "the model", model);
    } catch (mapped) {
      if (mapped instanceof StudioError) return mapped.toJSON();
    }
  }
  return { code: "INTERNAL", message: "Something went wrong while running the AI." };
}

/**
 * Runs `handler` as a Server-Sent Events stream. The handler sends progress events and returns
 * the `done` payload; a throw becomes `failed {error}`. Every stream ends with exactly one `done`
 * or `failed`. When the client disconnects, `signal` aborts (and with it any LLM request).
 */
export function sseTask(
  request: Request,
  handler: (context: SseContext) => Promise<Record<string, unknown> | void>,
  options: {
    log?: (line: string) => void;
    baseUrl?: string;
    model?: string;
    /** The AI task's label (US-19): named when its model is missing. */
    task?: string;
    /** US-21: replaces stored keys in the `failed` event with their hints. */
    scrub?: (text: string) => string;
  } = {},
): Response {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      const write = (event: string, data: unknown) => {
        if (closed) return;
        try {
          sink.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        request.signal?.removeEventListener("abort", abort);
        try {
          sink.close();
        } catch {
          // Already closed by a disconnect.
        }
      };
      void (async () => {
        try {
          const result = await handler({ signal: controller.signal, send: write });
          if (controller.signal.aborted) throw new LlmError("cancelled", "Cancelled.");
          // US-19 (D30): the final event names the model that ran.
          write("done", { ...(result ?? {}), ...(options.model ? { model: options.model } : {}) });
        } catch (error) {
          const apiError = controller.signal.aborted
            ? { code: "CANCELLED" as const, message: "Cancelled." }
            : aiError(error, options.baseUrl, options.model);
          if (apiError.code === "LLM_MODEL_NOT_FOUND" && options.task) {
            apiError.message = `${options.task} is set to use ${options.model ?? "a model"}, which the server doesn't have. ${apiError.message} Or pick another model for it in Settings → Model for each task.`;
          }
          if (apiError.code === "INTERNAL") options.log?.(`ai INTERNAL ${(error as Error)?.stack ?? error}`);
          write("failed", {
            error: options.scrub
              ? (JSON.parse(options.scrub(JSON.stringify(apiError))) as ApiError)
              : apiError,
          });
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      closed = true;
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
