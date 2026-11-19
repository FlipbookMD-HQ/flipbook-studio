import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasNonChatName, isOpenAiChatName } from "../src/shared/chatModels.js";
import { AnthropicProvider } from "../src/server/llm/anthropic.js";
import { apiKeyHint, scrubKeys } from "../src/server/llm/keys.js";
import { chatModels, isChatModel } from "../src/server/llm/models.js";
import {
  LlmError,
  OpenAiCompatibleProvider,
  chatText,
  resetResponseFormatMemory,
  resetStreamOptionsMemory,
} from "../src/server/llm/provider.js";
import { TEST_PROMPT } from "../src/server/llm/routes.js";
import { fixedBaseUrl, providerFor } from "../src/server/llm/target.js";
import { SettingsStore } from "../src/server/settings.js";
import { headers, makeApp, tempDir } from "./helpers.js";
import { startAnthropicStub, type AnthropicStub } from "./support/anthropic-stub.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";

// US-21 · 1.1.3: providerFor, OpenAI-compatible hardening, the key scrubber, the target forms of
// /api/llm/models and /api/llm/test, and the chat-model filter (D40). No real network.
const ANTHROPIC_KEY = "sk-ant-api03-plumbing-key-a1b2";
const OPENAI_KEY = "sk-proj-plumbing-openai-key-c3d4";
const OTHER_KEY = "sk-or-v1-plumbing-other-key-e5f6";

let llm: LlmStub;
let anthropic: AnthropicStub;
let logs: string[];
const env = {
  anthropic: process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL,
  openai: process.env.FLIPBOOK_STUDIO_OPENAI_URL,
};
beforeEach(async () => {
  resetResponseFormatMemory();
  resetStreamOptionsMemory();
  llm = await startLlmStub();
  anthropic = await startAnthropicStub({ apiKey: ANTHROPIC_KEY });
  // The fixed-URL kinds point at the fakes.
  process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL = anthropic.url;
  process.env.FLIPBOOK_STUDIO_OPENAI_URL = llm.url;
  logs = [];
});
afterEach(async () => {
  for (const [kind, value] of Object.entries(env)) {
    const name = `FLIPBOOK_STUDIO_${kind.toUpperCase()}_URL`;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await llm.close();
  await anthropic.close();
});

const signal = () => new AbortController().signal;
async function app() {
  return makeApp(await tempDir(), logs, { settings: await SettingsStore.open(await tempDir(), () => {}) });
}
type App = Awaited<ReturnType<typeof app>>;
const send = (instance: App, method: string, url: string, body?: unknown) =>
  instance.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const modelIds = async (instance: App, body: unknown) => {
  const response = await send(instance, "POST", "/api/llm/models", body);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return ((await response.json()).models as { id: string }[]).map((model) => model.id);
};

describe("the chat-model filter (D40)", () => {
  const NON_CHAT = [
    "nomic-embed-text",
    "text-embedding-3-small",
    "whisper-1",
    "gpt-image-1",
    "gpt-4o-realtime-preview",
  ];

  it("follows the rule table for each kind", () => {
    const table: [Parameters<typeof isChatModel>[0], Parameters<typeof isChatModel>[1], boolean][] = [
      ["anthropic", { id: "claude-sonnet-4-5" }, true],
      ["anthropic", { id: "claude-embed-anything" }, true],
      ["openai", { id: "gpt-4o" }, true],
      ["openai", { id: "gpt-4.1-mini" }, true],
      ["openai", { id: "chatgpt-4o-latest" }, true],
      ["openai", { id: "o3" }, true],
      ["openai", { id: "o4-mini" }, true],
      ["openai", { id: "gpt-3.5-turbo-instruct" }, false],
      ["openai", { id: "gpt-4o-mini-tts" }, false],
      ["openai", { id: "gpt-4o-transcribe" }, false],
      ["openai", { id: "gpt-4o-audio-preview" }, false],
      ["openai", { id: "dall-e-3" }, false],
      ["openai", { id: "omni-moderation-latest" }, false],
      ["openai", { id: "davinci-002" }, false],
      ["openai-compatible", { id: "meta-llama/llama-3.1-70b" }, true],
      ["openai-compatible", { id: "x/img", modalities: { input: ["text"], output: ["image"] } }, false],
      ["openai-compatible", { id: "x/see", modalities: { input: ["image"], output: ["text"] } }, false],
      [
        "openai-compatible",
        { id: "x/vision", modalities: { input: ["text", "image"], output: ["text"] } },
        true,
      ],
      // Capability fields win over the name.
      ["openai-compatible", { id: "x/embed-chat", modalities: { input: ["text"], output: ["text"] } }, true],
      ["openai-compatible", { id: "m-chat", capabilities: ["completion", "tools"] }, true],
      ["openai-compatible", { id: "m-chat2", capabilities: ["completion_chat"] }, true],
      ["openai-compatible", { id: "m-vec", capabilities: ["embedding"] }, false],
      ["openai-compatible", { id: "whisper-large" }, false],
      ["local", { id: "qwen2.5:0.5b" }, true],
      ["local", { id: "llama3.2:1b" }, true],
      ["local", { id: "nomic-embed-text" }, false],
      ["local", { id: "mxbai-embed-large" }, false],
    ];
    for (const [kind, model, expected] of table)
      expect(isChatModel(kind, model), `${kind} ${model.id}`).toBe(expected);
    for (const id of NON_CHAT) {
      expect(hasNonChatName(id) || !isOpenAiChatName(id), id).toBe(true);
      expect(isChatModel("openai", { id }), id).toBe(false);
      expect(isChatModel("local", { id }), id).toBe(false);
    }
    expect(chatModels("local", [{ id: "a", contextLength: 8192, capabilities: ["chat"] }])).toEqual([
      { id: "a", contextLength: 8192 },
    ]);
  });

  it("filters every list on the server: local, OpenAI, OpenRouter and Anthropic", async () => {
    const instance = await app();
    llm.setScript({ models: ["qwen2.5:0.5b", "nomic-embed-text", "llama3.2:1b"] });
    expect(await modelIds(instance, { baseUrl: llm.url })).toEqual(["qwen2.5:0.5b", "llama3.2:1b"]);

    llm.setScript({
      apiKey: OPENAI_KEY,
      models: [
        "gpt-4o",
        "text-embedding-3-small",
        "whisper-1",
        "gpt-image-1",
        "gpt-4o-realtime-preview",
        "o3",
        "babbage-002",
      ],
    });
    expect(await modelIds(instance, { kind: "openai", apiKey: OPENAI_KEY })).toEqual(["gpt-4o", "o3"]);

    llm.setScript({
      apiKey: OTHER_KEY,
      models: [
        {
          id: "anthropic/claude-sonnet-4.5",
          context_length: 1_000_000,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        },
        {
          id: "openai/gpt-image-1",
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        },
        { id: "openai/whisper", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
        { id: "mistral/embed" },
        { id: "mistral/large" },
      ],
    });
    const response = await send(instance, "POST", "/api/llm/models", {
      kind: "openai-compatible",
      baseUrl: llm.url,
      apiKey: OTHER_KEY,
    });
    expect(await response.json()).toEqual({
      models: [{ id: "anthropic/claude-sonnet-4.5", contextLength: 1_000_000 }, { id: "mistral/large" }],
    });

    expect(await modelIds(instance, { kind: "anthropic", apiKey: ANTHROPIC_KEY })).toEqual([
      "claude-opus-4-1-20250805",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
  });
});

describe("the three target forms", () => {
  it("uses a saved provider's stored key for {providerId}, sends it only to that provider and never back", async () => {
    const instance = await app();
    expect(
      (await send(instance, "POST", "/api/providers", { kind: "anthropic", apiKey: ANTHROPIC_KEY })).status,
    ).toBe(201);
    const models = await send(instance, "POST", "/api/llm/models", { providerId: "anthropic" });
    expect(models.status).toBe(200);
    const test = await send(instance, "POST", "/api/llm/test", {
      providerId: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(test.status).toBe(200);
    const body = await test.json();
    expect(body).toMatchObject({ reply: "Ready.", usage: { input: 18, output: 3 } });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(anthropic.requests.at(-1)!.body).toMatchObject({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: TEST_PROMPT }],
      temperature: 0,
    });
    expect(anthropic.requests.every((request) => request.headers["x-api-key"] === ANTHROPIC_KEY)).toBe(true);
    // The local stub never saw it.
    expect(llm.requests).toEqual([]);
    for (const text of [JSON.stringify(await models.json()), JSON.stringify(body), logs.join("\n")])
      expect(text).not.toContain(ANTHROPIC_KEY);

    const missing = await send(instance, "POST", "/api/llm/models", { providerId: "openai" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROVIDER_NOT_FOUND");
  });

  it("tests an unsaved {kind, baseUrl?, apiKey} and the old local body; usage comes back when reported", async () => {
    const instance = await app();
    llm.setScript({
      apiKey: OTHER_KEY,
      chat: [{ kind: "text", text: "Ready.", usage: { prompt: 9, completion: 2 } }],
    });
    const other = await send(instance, "POST", "/api/llm/test", {
      kind: "openai-compatible",
      baseUrl: llm.url,
      apiKey: OTHER_KEY,
      model: "mistral/large",
    });
    expect(await other.json()).toMatchObject({ reply: "Ready.", usage: { input: 9, output: 2 } });
    expect(llm.requests.at(-1)!.headers.authorization).toBe(`Bearer ${OTHER_KEY}`);

    llm.setScript({ chat: [{ kind: "text", text: "Ready." }] });
    const local = await send(instance, "POST", "/api/llm/test", { baseUrl: llm.url, model: "qwen2.5:0.5b" });
    expect(await local.json()).toMatchObject({ reply: "Ready.", usage: null });
    expect(llm.requests.at(-1)!.headers.authorization).toBeUndefined();

    const bad = [
      { kind: "anthropic", baseUrl: "https://elsewhere.example/v1", apiKey: ANTHROPIC_KEY },
      { kind: "openai-compatible", apiKey: OTHER_KEY },
      { kind: "openai-compatible", baseUrl: "http://example.com/v1", apiKey: OTHER_KEY },
      { kind: "openai", apiKey: "" },
      { providerId: "Not An ID" },
    ];
    for (const body of bad) {
      const response = await send(instance, "POST", "/api/llm/models", body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("OpenAI-compatible hardening", () => {
  it("asks for usage with stream_options, and remembers a server that rejects it", async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: llm.url });
    await chatText(provider, { model: "m", messages: [], signal: signal() });
    expect(llm.requests.at(-1)!.body).toMatchObject({ stream_options: { include_usage: true } });

    llm.setScript({
      rejectStreamOptions: true,
      chat: [{ kind: "text", text: "fine", usage: { prompt: 1, completion: 1 } }],
    });
    const before = llm.requests.length;
    expect(await chatText(provider, { model: "m", messages: [], signal: signal() })).toBe("fine");
    await chatText(provider, { model: "other", messages: [], signal: signal() });
    expect(llm.requests.slice(before).map((request) => "stream_options" in (request.body ?? {}))).toEqual([
      true,
      false,
      false,
    ]);

    // Both fallbacks in one request: response_format and stream_options.
    resetStreamOptionsMemory();
    llm.setScript({
      rejectStreamOptions: true,
      rejectResponseFormat: true,
      chat: [{ kind: "json", value: { ok: 1 } }],
    });
    const start = llm.requests.length;
    expect(
      JSON.parse(await chatText(provider, { model: "both", messages: [], jsonSchema: {}, signal: signal() })),
    ).toEqual({ ok: 1 });
    expect(
      llm.requests
        .slice(start)
        .map((request) => Object.keys(request.body ?? {}).filter((key) => /format|options/.test(key))),
    ).toEqual([["stream_options", "response_format"], ["stream_options"], []]);
  });

  it("maps insufficient_quota and 402 to no_credit, any other 429 to rate_limited, and 'not a chat model' to model_not_found", async () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: llm.url, apiKey: OPENAI_KEY });
    const run = async () => {
      try {
        await chatText(provider, { model: "davinci-002", messages: [], signal: signal() });
      } catch (error) {
        return error as LlmError;
      }
      throw new Error("expected a failure");
    };
    const quota = JSON.stringify({
      error: {
        message: "You exceeded your current quota.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    llm.setScript({ chat: [{ kind: "status", status: 429, body: quota }] });
    expect((await run()).kind).toBe("no_credit");
    llm.setScript({ chat: [{ kind: "status", status: 402, body: "Insufficient credits" }] });
    expect((await run()).kind).toBe("no_credit");
    llm.setScript({
      chat: [{ kind: "status", status: 429, body: "Rate limit reached", headers: { "retry-after": "20" } }],
    });
    const limited = await run();
    expect(limited.kind).toBe("rate_limited");
    expect(limited.retryAfterS).toBe(20);
    llm.setScript({
      chat: [
        {
          kind: "status",
          status: 404,
          body: "This is not a chat model and thus not supported in the v1/chat/completions endpoint.",
        },
      ],
    });
    expect(await run()).toMatchObject({
      kind: "model_not_found",
      message: expect.stringContaining("not a chat model"),
    });
  });

  it("refuses redirects and treats an HTML page as unreachable", async () => {
    const elsewhere: string[] = [];
    const other = http.createServer((req, res) => {
      elsewhere.push(String(req.headers.authorization));
      res.end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const location = `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/chat/completions`;
      llm.setScript({ chat: [{ kind: "redirect", location }] });
      const provider = new OpenAiCompatibleProvider({ baseUrl: llm.url, apiKey: OPENAI_KEY });
      await expect(chatText(provider, { model: "m", messages: [], signal: signal() })).rejects.toMatchObject({
        kind: "unreachable",
        message: expect.stringMatching(/redirect/),
      });
      expect(elsewhere).toEqual([]);
      llm.setScript({ chat: [{ kind: "html" }] });
      await expect(chatText(provider, { model: "m", messages: [], signal: signal() })).rejects.toMatchObject({
        kind: "unreachable",
        message: expect.stringContaining(`Unexpected response from ${new URL(llm.url).host}`),
      });
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("maps the new kinds through the routes: LLM_NO_CREDIT and LLM_RATE_LIMITED (502)", async () => {
    const instance = await app();
    await send(instance, "POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY });
    llm.setScript({
      chat: [{ kind: "status", status: 429, body: '{"error":{"code":"insufficient_quota"}}' }],
    });
    const credit = await send(instance, "POST", "/api/llm/test", { providerId: "openai", model: "gpt-4o" });
    expect(credit.status).toBe(502);
    expect((await credit.json()).error).toMatchObject({
      code: "LLM_NO_CREDIT",
      message: "Your OpenAI account has no credit left.",
    });
    llm.setScript({
      chat: [{ kind: "status", status: 429, body: "slow down", headers: { "retry-after": "5" } }],
    });
    const limited = await send(instance, "POST", "/api/llm/test", { providerId: "openai", model: "gpt-4o" });
    expect(limited.status).toBe(502);
    expect((await limited.json()).error).toMatchObject({
      code: "LLM_RATE_LIMITED",
      message: expect.stringContaining("try again in 5 s"),
      details: { retryAfterS: 5 },
    });
  });
});

describe("the key scrubber", () => {
  it("replaces every stored key, plain or JSON-escaped, with its hint", () => {
    const key = 'sk-proj-quote"slash\\-tail9876';
    const text = `failed with ${OPENAI_KEY} and ${JSON.stringify({ key })} and ${OPENAI_KEY}`;
    const out = scrubKeys(text, [OPENAI_KEY, key, null, "short"]);
    expect(out).toBe(`failed with ${apiKeyHint(OPENAI_KEY)} and {"key":"${apiKeyHint(key)}"} and sk-…c3d4`);
    expect(out).not.toContain("plumbing");
  });

  it("keeps stored keys out of every error and log line, showing the hint instead", async () => {
    const instance = await app();
    await send(instance, "POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY });
    await send(instance, "PUT", "/api/settings", {
      llm: { baseUrl: llm.url, apiKey: "sk-local-secret-123456" },
    });

    // An upstream that echoes the key back in its error body.
    llm.setScript({
      apiKey: "something-else-entirely",
      models: { kind: "status", status: 500, body: `bad key ${OPENAI_KEY}` },
    });
    const wrong = await send(instance, "POST", "/api/llm/models", { providerId: "openai" });
    const unauthorized = (await wrong.json()).error;
    expect(unauthorized).toMatchObject({
      code: "LLM_UNAUTHORIZED",
      message: expect.stringContaining("sk-…c3d4"),
    });

    llm.setScript({
      models: { kind: "status", status: 500, body: `bad key ${OPENAI_KEY} / sk-local-secret-123456` },
    });
    for (const body of [{ providerId: "openai" }, { baseUrl: llm.url }]) {
      const text = await (await send(instance, "POST", "/api/llm/models", body)).text();
      expect(text).not.toContain(OPENAI_KEY);
      expect(text).not.toContain("sk-local-secret-123456");
    }
    const unsaved = await (
      await send(instance, "POST", "/api/llm/models", {
        kind: "openai-compatible",
        baseUrl: llm.url,
        apiKey: OTHER_KEY,
      })
    ).text();
    expect(unsaved).not.toContain(OTHER_KEY);

    // A key in a URL: the 404 message and the request log line both show the hint.
    const odd = await send(instance, "DELETE", `/api/providers/${OPENAI_KEY}`);
    expect(odd.status).toBe(404);
    const message = (await odd.json()).error.message;
    expect(message).toContain("sk-…c3d4");
    expect(message).not.toContain(OPENAI_KEY);
    const all = logs.join("\n");
    expect(all).toContain("sk-…c3d4");
    expect(all).not.toContain(OPENAI_KEY);
    expect(all).not.toContain("sk-local-secret-123456");
  });
});

describe("providerFor", () => {
  it("builds the Anthropic adapter for anthropic, and the OpenAI-compatible one for the rest", () => {
    expect(providerFor({ kind: "anthropic", baseUrl: anthropic.url, apiKey: ANTHROPIC_KEY })).toBeInstanceOf(
      AnthropicProvider,
    );
    for (const kind of ["openai", "openai-compatible", "local"] as const)
      expect(providerFor({ kind, baseUrl: llm.url, apiKey: OPENAI_KEY }), kind).toBeInstanceOf(
        OpenAiCompatibleProvider,
      );
    expect(providerFor({ baseUrl: llm.url })).toBeInstanceOf(OpenAiCompatibleProvider);
  });

  it("knows the fixed base URLs", () => {
    expect(fixedBaseUrl("anthropic", {})).toBe("https://api.anthropic.com/v1");
    expect(fixedBaseUrl("openai", {})).toBe("https://api.openai.com/v1");
  });
});
