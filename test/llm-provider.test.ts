import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LlmError,
  OpenAiCompatibleProvider,
  chatText,
  normalizeBaseUrl,
  resetResponseFormatMemory,
  type ChatEvent,
} from "../src/server/llm/provider.js";
import { FakeProvider } from "./support/fake-provider.js";
import { HOSTILE_OUTPUT } from "./support/llm-fixtures.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";

let stub: LlmStub;
beforeEach(async () => {
  resetResponseFormatMemory();
  stub = await startLlmStub();
});
afterEach(() => stub.close());

const signal = () => new AbortController().signal;
const ask = (
  provider: OpenAiCompatibleProvider,
  extra: Partial<Parameters<OpenAiCompatibleProvider["chat"]>[0]> = {},
) =>
  provider.chat({
    model: "stub-model",
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

describe("normalizeBaseUrl", () => {
  it("adds or keeps one /v1 and drops trailing slashes", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:11434/")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeBaseUrl(" http://127.0.0.1:1234/v1/ ")).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("OpenAiCompatibleProvider against the stub", () => {
  it("lists models with either URL form", async () => {
    stub.setScript({ models: ["qwen2.5:0.5b", "llama3.2"] });
    for (const baseUrl of [stub.url, stub.url.replace(/\/v1$/, "/")]) {
      const models = await new OpenAiCompatibleProvider({ baseUrl }).listModels(signal());
      expect(models).toEqual([{ id: "qwen2.5:0.5b" }, { id: "llama3.2" }]);
    }
    expect(stub.requests.map((request) => request.path)).toEqual(["/v1/models", "/v1/models"]);
  });

  it("streams deltas in order, then done with usage, and sends the bearer header only with a key", async () => {
    stub.setScript({ chat: [{ kind: "text", text: "one two three", usage: { prompt: 7, completion: 3 } }] });
    const events = await collect(ask(new OpenAiCompatibleProvider({ baseUrl: stub.url })));
    expect(events).toEqual([
      { type: "delta", text: "one " },
      { type: "delta", text: "two " },
      { type: "delta", text: "three" },
      { type: "done", usage: { prompt: 7, completion: 3 } },
    ]);
    expect(stub.requests[0]!.headers.authorization).toBeUndefined();
    expect(stub.requests[0]!.body).toMatchObject({ model: "stub-model", stream: true });

    stub.setScript({ apiKey: "sk-test" });
    expect(
      await chatText(new OpenAiCompatibleProvider({ baseUrl: stub.url, apiKey: "sk-test" }), {
        model: "m",
        messages: [],
        signal: signal(),
      }),
    ).toBe("ready");
    expect(stub.requests.at(-1)!.headers.authorization).toBe("Bearer sk-test");
  });

  it("maps failures: refused, 401, 403, model 404, 5xx", async () => {
    const closed = await startLlmStub();
    const deadUrl = closed.url;
    await closed.close();
    expect(
      (await failure(new OpenAiCompatibleProvider({ baseUrl: deadUrl }).listModels(signal()))).kind,
    ).toBe("unreachable");

    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.url });
    stub.setScript({ models: { kind: "status", status: 401 } });
    const unauthorized = await failure(provider.listModels(signal()));
    expect(unauthorized.kind).toBe("unauthorized");
    expect(unauthorized.message).toContain(stub.url);
    for (const [status, kind] of [
      [403, "unauthorized"],
      [404, "model_not_found"],
      [500, "unreachable"],
    ] as const) {
      stub.setScript({ chat: [{ kind: "status", status }] });
      expect((await failure(collect(ask(provider)))).kind).toBe(kind);
    }
  });

  it("times out when no token arrives, and an abort cancels mid-stream", async () => {
    stub.setScript({ chat: [{ kind: "hang" }] });
    const slow = new OpenAiCompatibleProvider({ baseUrl: stub.url, timeoutMs: 150 });
    expect((await failure(collect(ask(slow)))).kind).toBe("timeout");

    stub.setScript({ chat: [{ kind: "slowTokens", ms: 40, text: "a b c d e f g h" }] });
    const controller = new AbortController();
    const seen: string[] = [];
    const error = await failure(
      (async () => {
        for await (const event of ask(new OpenAiCompatibleProvider({ baseUrl: stub.url }), {
          signal: controller.signal,
        })) {
          if (event.type === "delta") seen.push(event.text);
          if (seen.length === 2) controller.abort();
        }
      })(),
    );
    expect(error.kind).toBe("cancelled");
    expect(seen).toEqual(["a ", "b "]);

    // Slow but steady tokens don't time out: the timer restarts on each token.
    stub.setScript({ chat: [{ kind: "slowTokens", ms: 60, text: "x y z w" }] });
    const steady = new OpenAiCompatibleProvider({ baseUrl: stub.url, timeoutMs: 150 });
    expect(await chatText(steady, { model: "m", messages: [], signal: signal() })).toBe("x y z w");
  });

  it("sends response_format, falls back once on a 400, and skips it afterwards", async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.url });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    stub.setScript({ chat: [{ kind: "json", value: { ok: true } }] });
    expect(
      JSON.parse(
        await chatText(provider, { model: "m", messages: [], jsonSchema: schema, signal: signal() }),
      ),
    ).toEqual({ ok: true });
    expect(stub.requests.at(-1)!.body).toHaveProperty("response_format.type", "json_schema");

    stub.setScript({ rejectResponseFormat: true, chat: [{ kind: "json", value: { ok: false } }] });
    const before = stub.requests.length;
    await chatText(provider, { model: "picky", messages: [], jsonSchema: schema, signal: signal() });
    const first = stub.requests.slice(before);
    expect(first.map((request) => "response_format" in (request.body ?? {}))).toEqual([true, false]);
    await chatText(provider, { model: "picky", messages: [], jsonSchema: schema, signal: signal() });
    expect(
      stub.requests.slice(before + 2).map((request) => "response_format" in (request.body ?? {})),
    ).toEqual([false]);
  });
});

describe("FakeProvider", () => {
  it("answers from the same fixtures, including hostile output and status failures", async () => {
    const fake = new FakeProvider({
      chat: [{ kind: "hostile" }, { kind: "status", status: 404 }, { kind: "invalidJson" }],
    });
    const run = () =>
      chatText(fake, { model: "m", messages: [{ role: "user", content: "x" }], signal: signal() });
    expect(JSON.parse(await run())).toEqual(HOSTILE_OUTPUT);
    expect((await failure(run())).kind).toBe("model_not_found");
    await expect(run().then(JSON.parse)).rejects.toThrow(SyntaxError);
    expect(fake.requests).toHaveLength(3);
    expect(await fake.listModels()).toEqual([{ id: "stub-model" }]);
  });
});
