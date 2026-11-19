import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_CONTEXT_LENGTH,
  ANTHROPIC_VERSION,
  AnthropicProvider,
  MAX_OUTPUT_TOKENS,
} from "../src/server/llm/anthropic.js";
import { LlmError, chatText, type ChatEvent, type ChatRequest } from "../src/server/llm/provider.js";
import {
  RECORDED_ERRORS,
  RECORDED_MODELS,
  RECORDED_OVERLOADED_STREAM,
  RECORDED_REPLY,
  recordedText,
} from "./support/anthropic-fixtures.js";
import { startAnthropicStub, type AnthropicStub } from "./support/anthropic-stub.js";

// US-21 · 1.1.2: the Anthropic adapter (D33, D35) against a fake Anthropic server. No real network.
const KEY = "sk-ant-api03-test-key-0000a1b2";

let stub: AnthropicStub;
beforeEach(async () => {
  stub = await startAnthropicStub({ apiKey: KEY });
});
afterEach(() => stub.close());

const signal = () => new AbortController().signal;
const claude = (extra: { timeoutMs?: number; apiKey?: string } = {}) =>
  new AnthropicProvider({ kind: "anthropic", baseUrl: stub.url, apiKey: KEY, ...extra });
const ask = (provider: AnthropicProvider, extra: Partial<ChatRequest> = {}) =>
  provider.chat({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hi" }],
    signal: signal(),
    ...extra,
  });
async function collect(events: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error("expected an LlmError");
}

describe("AnthropicProvider.listModels", () => {
  it("lists every model with the default context length, sending the key and version headers", async () => {
    const models = await claude().listModels(signal());
    expect(models).toEqual(
      RECORDED_MODELS.map((model) => ({ id: model.id, contextLength: ANTHROPIC_CONTEXT_LENGTH })),
    );
    expect(ANTHROPIC_CONTEXT_LENGTH).toBe(200_000);
    const request = stub.requests[0]!;
    expect(request.path).toBe("/v1/models");
    expect(request.headers["x-api-key"]).toBe(KEY);
    expect(request.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(request.headers.authorization).toBeUndefined();
  });

  it("follows pagination and uses a reported context length", async () => {
    stub.setScript({
      apiKey: KEY,
      pageSize: 2,
      models: [...RECORDED_MODELS, { type: "model", id: "claude-long", max_input_tokens: 1_000_000 }],
    });
    const models = await claude().listModels(signal());
    expect(models.map((model) => model.id)).toEqual([
      ...RECORDED_MODELS.map((model) => model.id),
      "claude-long",
    ]);
    expect(models.at(-1)!.contextLength).toBe(1_000_000);
    expect(stub.requests).toHaveLength(2);
  });

  it("maps a wrong key to unauthorized", async () => {
    const error = await failure(claude({ apiKey: "sk-ant-wrong-key-000000" }).listModels(signal()));
    expect(error.kind).toBe("unauthorized");
    expect(error.message).toContain(stub.url);
    expect(error.message).not.toContain("sk-ant-wrong");
  });
});

describe("AnthropicProvider.chat", () => {
  it("replays a recorded stream: deltas in order, then done with usage from message_start and message_delta", async () => {
    const events = await collect(ask(claude()));
    expect(events).toEqual([
      { type: "delta", text: "Ready" },
      { type: "delta", text: "." },
      { type: "done", usage: { prompt: 18, completion: 3 } },
    ]);
  });

  it("lifts system messages to the top level and sends max_tokens per task", async () => {
    stub.setScript({ apiKey: KEY, chat: [{ kind: "stream", events: recordedText("ok") }] });
    await chatText(claude(), {
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello." },
        { role: "system", content: "Answer in JSON." },
        { role: "user", content: "Again" },
      ],
      temperature: 1.6,
      jsonSchema: { type: "object" },
      signal: signal(),
    });
    expect(stub.requests[0]!.path).toBe("/v1/messages");
    expect(stub.requests[0]!.body).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 4_096,
      system: "Be brief.\n\nAnswer in JSON.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello." },
        { role: "user", content: "Again" },
      ],
      stream: true,
      temperature: 1,
    });
    expect(MAX_OUTPUT_TOKENS).toEqual({ generate: 8_192, draft: 8_192, rewrite: 4_096, chat: 4_096 });
    for (const task of ["generate", "draft", "rewrite", "chat"] as const) {
      await chatText(claude(), {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        task,
        signal: signal(),
      });
      expect(stub.requests.at(-1)!.body!.max_tokens, task).toBe(MAX_OUTPUT_TOKENS[task]);
    }
  });

  it("maps each recorded error to its kind", async () => {
    const cases = [
      [RECORDED_ERRORS.unauthorized, "unauthorized"],
      [RECORDED_ERRORS.forbidden, "unauthorized"],
      [RECORDED_ERRORS.notFound, "model_not_found"],
      [RECORDED_ERRORS.rateLimited, "rate_limited"],
      [RECORDED_ERRORS.overloaded, "rate_limited"],
      [RECORDED_ERRORS.noCredit, "no_credit"],
      [RECORDED_ERRORS.badRequest, "unreachable"],
    ] as const;
    for (const [recorded, kind] of cases) {
      stub.setScript({ apiKey: KEY, chat: [{ kind: "status", ...recorded }] });
      const error = await failure(collect(ask(claude())));
      expect(error.kind, recorded.body).toBe(kind);
      expect(error.status).toBe(recorded.status);
    }
    stub.setScript({ apiKey: KEY, chat: [{ kind: "status", ...RECORDED_ERRORS.rateLimited }] });
    expect((await failure(collect(ask(claude())))).retryAfterS).toBe(17);
  });

  it("maps an error event in the middle of a stream", async () => {
    stub.setScript({ apiKey: KEY, chat: [{ kind: "stream", events: RECORDED_OVERLOADED_STREAM }] });
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of ask(claude())) if (event.type === "delta") seen.push(event.text);
      })(),
    );
    expect(seen).toEqual(["Rea"]);
    expect(error.kind).toBe("rate_limited");
  });

  it("refuses a redirect, so the key never goes to another host", async () => {
    const elsewhere: http.IncomingHttpHeaders[] = [];
    const other = http.createServer((req, res) => {
      elsewhere.push(req.headers);
      res.end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const location = `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/messages`;
    try {
      stub.setScript({
        apiKey: KEY,
        chat: [{ kind: "redirect", location }],
        models: { kind: "redirect", location },
      });
      const error = await failure(collect(ask(claude())));
      expect(error.kind).toBe("unreachable");
      expect(error.message).toMatch(/redirect/);
      expect((await failure(claude().listModels(signal()))).message).toMatch(/redirect/);
      expect(elsewhere).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("treats an HTML page (a captive portal) as unreachable, naming the host", async () => {
    stub.setScript({ apiKey: KEY, chat: [{ kind: "html" }], models: { kind: "html" } });
    const host = new URL(stub.url).host;
    for (const run of [() => collect(ask(claude())), () => claude().listModels(signal())]) {
      const error = await failure(run());
      expect(error.kind).toBe("unreachable");
      expect(error.message).toContain(`Unexpected response from ${host}`);
    }
  });

  it("times out when nothing arrives, and keeps going while events do", async () => {
    stub.setScript({ apiKey: KEY, chat: [{ kind: "hang" }] });
    expect((await failure(collect(ask(claude({ timeoutMs: 150 }))))).kind).toBe("timeout");

    stub.setScript({ apiKey: KEY, chat: [{ kind: "stream", events: recordedText("a b c d"), delayMs: 60 }] });
    expect(await chatText(claude({ timeoutMs: 150 }), { model: "m", messages: [], signal: signal() })).toBe(
      "a b c d",
    );
  });

  it("is cancelled by the caller's signal", async () => {
    stub.setScript({
      apiKey: KEY,
      chat: [{ kind: "stream", events: recordedText("one two three four five"), delayMs: 40 }],
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of ask(claude(), { signal: controller.signal })) {
          if (event.type === "delta") seen.push(event.text);
          if (seen.length === 2) controller.abort();
        }
      })(),
    );
    expect(error.kind).toBe("cancelled");
    expect(seen).toEqual(["one ", "two "]);
  });

  it("finishes a recorded reply that ends without message_stop", async () => {
    stub.setScript({
      apiKey: KEY,
      chat: [{ kind: "stream", events: RECORDED_REPLY.replace(/event: message_stop[\s\S]*$/, "") }],
    });
    expect(await collect(ask(claude()))).toEqual([
      { type: "delta", text: "Ready" },
      { type: "delta", text: "." },
      { type: "done", usage: { prompt: 18, completion: 3 } },
    ]);
  });
});
