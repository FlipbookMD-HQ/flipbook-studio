import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { AI_TASKS, type AiTask, type Settings, type TaskModels } from "../src/shared/api.js";
import { resetContextCache } from "../src/server/ai/budget.js";
import { HOSTED_CONTEXT_LENGTH, resolveTaskLlm } from "../src/server/ai/resolve.js";
import { ANTHROPIC_CONTEXT_LENGTH } from "../src/server/llm/anthropic.js";
import { resetResponseFormatMemory, resetStreamOptionsMemory } from "../src/server/llm/provider.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { RECORDED_ERRORS, recordedText } from "./support/anthropic-fixtures.js";
import { startAnthropicStub, type AnthropicReply, type AnthropicStub } from "./support/anthropic-stub.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture } from "./support/llm-fixtures.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";
import { sseEvents } from "./support/sse.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-24 · 1.1.2: each AI route resolves its provider per run, with no fallback (D30, D41), on the
// fake Anthropic and OpenAI servers. No real network.
const ANTHROPIC_KEY = "sk-ant-api03-task-providers-a1b2";
const OPENAI_KEY = "sk-proj-task-providers-openai-c3d4";
const LOCAL = { id: "local", label: "Local", kind: "local" };
const ANTHROPIC = { id: "anthropic", label: "Anthropic", kind: "anthropic" };
const OPENAI = { id: "openai", label: "OpenAI", kind: "openai" };
const CLAUDE = "claude-sonnet-4-5";
const deckId = encodeDeckId("deck");
const SLIDE = "slides/01.slide.md";
const KIT = "marvel_content_guide";

const COVER = { type: "cover", markdown: "# Reading guide\n\n![Hero](image.png)\n\nWhere to start." };
const timeline = (n: number, items = 2) => ({
  type: "timeline",
  markdown: `# Phase ${n}\n\n${Array.from({ length: items }, (_, i) => `- Stop ${i + 1}`).join("\n")}`,
});
const jsonLines = (...slides: object[]) => `${slides.map((slide) => JSON.stringify(slide)).join("\n")}\n`;
const THEME = {
  css: ":host { --slide-bg: #101820; --slide-text: #f2f2f2; --slide-muted: #a0a8b0; --slide-accent: #ffb000; --slide-mint: #6fe3c1; --slide-heading: #fff; --slide-line: #2a3440; --slide-code: #0b1116; }",
};
/** What each task's model answers, as text. */
const ANSWERS: Record<AiTask | "file", string> = {
  rewrite: JSON.stringify({ markdown: "# First, shorter\n" }),
  generate: jsonLines({ type: null, markdown: "# Cover" }),
  file: jsonLines({ type: null, markdown: "# Notes" }),
  draft: JSON.stringify(THEME),
  chat: "It has two slides.",
};
const asFixture = (text: string): LlmFixture => ({ kind: "text", text });

let local: LlmStub;
let openai: LlmStub;
let anthropic: AnthropicStub;
const env = {
  anthropic: process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL,
  openai: process.env.FLIPBOOK_STUDIO_OPENAI_URL,
};
/** The answer every fake gives next (each test sets it per task). */
let answer = ANSWERS.chat;

beforeEach(async () => {
  resetContextCache();
  resetResponseFormatMemory();
  resetStreamOptionsMemory();
  local = await startLlmStub({ script: { models: ["small", "big"], chat: () => asFixture(answer) } });
  openai = await startLlmStub({
    script: { apiKey: OPENAI_KEY, models: ["gpt-4o", "gpt-4o-mini"], chat: () => asFixture(answer) },
  });
  anthropic = await startAnthropicStub({
    apiKey: ANTHROPIC_KEY,
    chat: () => ({ kind: "stream", events: recordedText(answer) }),
  });
  process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL = anthropic.url;
  process.env.FLIPBOOK_STUDIO_OPENAI_URL = openai.url;
});
afterEach(async () => {
  for (const [kind, value] of Object.entries(env)) {
    const name = `FLIPBOOK_STUDIO_${kind.toUpperCase()}_URL`;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all([local.close(), openai.close(), anthropic.close()]);
});

async function setup(taskModels?: TaskModels, maxRepairRounds = 1) {
  const root = await tempDir();
  await write(
    root,
    Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`deck/${name}`, body])),
  );
  const settings = await SettingsStore.open(await tempDir(), () => {});
  const logs: string[] = [];
  const app = await makeApp(root, logs, { settings });
  const send = (method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await send("PUT", "/api/settings", { llm: { baseUrl: local.url, model: "small", maxRepairRounds } });
  expect((await send("POST", "/api/providers", { kind: "anthropic", apiKey: ANTHROPIC_KEY })).status).toBe(
    201,
  );
  expect((await send("POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY })).status).toBe(201);
  if (taskModels) expect((await send("PUT", "/api/settings", { llm: { taskModels } })).status).toBe(200);
  const upload = async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.from("# Notes\n\n## One\n\nx\n")], "notes.md"));
    const response = await app.request("/api/sources", { method: "POST", headers: headers(), body: form });
    return (await response.json()).source.sourceId as string;
  };
  const request = async (task: AiTask | "file", extra: object = {}) => {
    const hash = hashBytes(await fs.readFile(path.join(root, "deck", SLIDE)));
    const name = `deck-${Math.random().toString(36).slice(2, 8)}`;
    const deck = { name, title: "T", kind: "folder", group: null, ...extra };
    return {
      rewrite: () =>
        send("POST", "/api/ai/rewrite", {
          deckId,
          slideId: SLIDE,
          baseHash: hash,
          instruction: { kind: "shorten" },
        }),
      generate: () => send("POST", "/api/ai/generate-deck", { ...deck, source: { topic: "Indexes" } }),
      file: async () =>
        send("POST", "/api/ai/generate-deck", { ...deck, source: { sourceId: await upload() } }),
      draft: () =>
        send("POST", "/api/ai/draft-kit", { kind: "theme", name: `t-${name}`, description: "Calm." }),
      chat: () =>
        send("POST", "/api/ai/chat", { deckId, sessionId: null, message: "How many slides?", ...extra }),
    }[task]();
  };
  /** Runs one task to its end and returns its events. */
  const run = async (task: AiTask | "file", extra: object = {}) => {
    answer = ANSWERS[task];
    const response = await request(task, extra);
    expect(response.status).toBe(200);
    return sseEvents(response);
  };
  return { root, app, send, run, request, logs };
}

/** Chat requests each fake received. */
const chats = () => ({
  local: local.requests.filter((item) => item.path === "/v1/chat/completions"),
  openai: openai.requests.filter((item) => item.path === "/v1/chat/completions"),
  anthropic: anthropic.requests.filter((item) => item.path === "/v1/messages"),
});
const reset = () => {
  local.requests.length = 0;
  openai.requests.length = 0;
  anthropic.requests.length = 0;
};
const final = (events: { event: string; data: unknown }[]) => events.at(-1)!;

describe("each AI route runs on its task's provider", () => {
  it("sends every task set to Anthropic only to Anthropic, with start, done and max_tokens (D35)", async () => {
    const { run } = await setup(
      Object.fromEntries(AI_TASKS.map((task) => [task, { provider: "anthropic", model: CLAUDE }])),
    );
    const maxTokens = { rewrite: 4_096, generate: 8_192, file: 8_192, draft: 8_192, chat: 4_096 };
    for (const task of ["rewrite", "generate", "file", "draft", "chat"] as const) {
      reset();
      const events = await run(task);
      expect(events[0], task).toEqual({ event: "start", data: { provider: ANTHROPIC, model: CLAUDE } });
      expect(final(events).event, `${task}: ${JSON.stringify(final(events))}`).toBe("done");
      expect(final(events).data, task).toMatchObject({ provider: ANTHROPIC, model: CLAUDE });
      const sent = chats();
      expect(sent.local, task).toHaveLength(0);
      expect(sent.openai, task).toHaveLength(0);
      expect(sent.anthropic.length, task).toBeGreaterThan(0);
      for (const request of sent.anthropic) {
        expect(request.body, task).toMatchObject({ model: CLAUDE, max_tokens: maxTokens[task] });
        expect(request.headers["x-api-key"], task).toBe(ANTHROPIC_KEY);
      }
      // Nothing at all went to the local server (not even a model list).
      expect(local.requests, task).toHaveLength(0);
    }
  });

  it("sends tasks set to OpenAI only to OpenAI", async () => {
    const { run } = await setup({ chat: { provider: "openai", model: "gpt-4o" }, rewrite: "big" });
    const chat = await run("chat");
    expect(chat[0]).toEqual({ event: "start", data: { provider: OPENAI, model: "gpt-4o" } });
    expect(final(chat).data).toMatchObject({ provider: OPENAI, model: "gpt-4o" });
    expect(chats().openai.map((request) => request.headers.authorization)).toEqual([`Bearer ${OPENAI_KEY}`]);
    expect(chats().local).toHaveLength(0);
    expect(chats().anthropic).toHaveLength(0);

    // The other tasks stay local.
    reset();
    const rewrite = await run("rewrite");
    expect(rewrite[0]).toEqual({ event: "start", data: { provider: LOCAL, model: "big" } });
    expect(final(rewrite).data).toMatchObject({ provider: LOCAL, model: "big" });
    expect(chats().local.map((request) => request.body?.model)).toEqual(["big"]);
    expect(chats().openai).toHaveLength(0);
  });

  it("reports Local for local runs, and sends no max_tokens there", async () => {
    const { run } = await setup();
    for (const task of ["rewrite", "generate", "file", "draft", "chat"] as const) {
      reset();
      const events = await run(task);
      expect(events[0], task).toEqual({ event: "start", data: { provider: LOCAL, model: "small" } });
      expect(final(events), task).toMatchObject({ event: "done", data: { provider: LOCAL, model: "small" } });
      expect(chats().anthropic, task).toHaveLength(0);
      for (const request of chats().local) expect(request.body && "max_tokens" in request.body).toBe(false);
    }
  });

  it("runs the generate repair loop on Anthropic", async () => {
    const { send, run } = await setup({ generate: { provider: "anthropic", model: CLAUDE } });
    const replies: AnthropicReply[] = [
      { kind: "stream", events: recordedText(jsonLines(COVER, timeline(1), timeline(2, 7))) },
      { kind: "stream", events: recordedText(JSON.stringify(timeline(2))) },
    ];
    anthropic.setScript({ apiKey: ANTHROPIC_KEY, chat: replies });
    const events = await run("generate", { name: "guide", title: "Reading guide", group: KIT });
    expect(events.map((event) => event.event)).toEqual([
      "start",
      "slide",
      "slide",
      "slide",
      "repair",
      "done",
    ]);
    expect(final(events).data).toMatchObject({ violations: [], provider: ANTHROPIC, model: CLAUDE });
    const sent = chats().anthropic;
    expect(sent).toHaveLength(2);
    expect(sent.map((request) => request.body?.max_tokens)).toEqual([8_192, 8_192]);
    const repair = (sent[1]!.body!.messages as { content: string }[]).at(-1)!.content;
    expect(repair).toContain("# Phase 2");
    expect(chats().local).toHaveLength(0);
    expect((await send("GET", `/api/decks/${encodeDeckId("guide")}`)).status).toBe(200);
  });

  it("answers 409 LLM_PROVIDER_MISSING before streaming when the provider was removed", async () => {
    const { send, request, root } = await setup({
      generate: { provider: "anthropic", model: CLAUDE },
      chat: { provider: "anthropic", model: CLAUDE },
    });
    expect((await send("DELETE", "/api/providers/anthropic")).status).toBe(204);
    reset();
    const before = (await fs.readdir(root)).sort();
    for (const task of ["generate", "file", "chat"] as const) {
      const response = await request(task);
      expect(response.status, task).toBe(409);
      expect(response.headers.get("content-type"), task).toMatch(/json/);
      const { error } = await response.json();
      expect(error, task).toMatchObject({
        code: "LLM_PROVIDER_MISSING",
        details: { task: task === "file" ? "generate" : task, provider: "anthropic" },
      });
      expect(error.message, task).toMatch(/^(Generate a deck|Chat) uses anthropic, which was removed\./);
    }
    // Nothing reached any server, and nothing was written; the local tasks still run.
    expect(chats()).toEqual({ local: [], openai: [], anthropic: [] });
    expect(local.requests).toHaveLength(0);
    expect((await fs.readdir(root)).filter((name) => name !== ".flipbook-studio-tmp").sort()).toEqual(
      before.filter((name) => name !== ".flipbook-studio-tmp"),
    );
    const rewrite = await sseEvents(await request("rewrite"));
    expect(final(rewrite).data).toMatchObject({ provider: LOCAL });
  });

  it("fails a run whose key is rejected with LLM_UNAUTHORIZED, naming task and provider, with no fallback", async () => {
    const { run, logs } = await setup({ rewrite: { provider: "anthropic", model: CLAUDE } });
    anthropic.setScript({ chat: () => ({ kind: "status", ...RECORDED_ERRORS.unauthorized }) });
    const events = await run("rewrite");
    expect(events.map((event) => event.event)).toEqual(["start", "failed"]);
    const failed = final(events).data as { error: { code: string; message: string }; provider: unknown };
    expect(failed.provider).toEqual(ANTHROPIC);
    expect(failed.error.code).toBe("LLM_UNAUTHORIZED");
    expect(failed.error.message).toContain("Rewrite a slide");
    expect(failed.error.message).toContain("Anthropic");
    expect(failed.error.message).toContain("sk-…a1b2");
    expect(JSON.stringify(events)).not.toContain(ANTHROPIC_KEY);
    expect(logs.join("\n")).not.toContain(ANTHROPIC_KEY);
    // Exactly one attempt, on Anthropic only: no retry (D41) and no fallback.
    expect(chats().anthropic).toHaveLength(1);
    expect(chats().local).toHaveLength(0);
    expect(chats().openai).toHaveLength(0);
  });

  it("names the provider when its model is gone", async () => {
    const { run } = await setup({ chat: { provider: "anthropic", model: "claude-nope" } });
    anthropic.setScript({
      apiKey: ANTHROPIC_KEY,
      chat: () => ({ kind: "status", ...RECORDED_ERRORS.notFound }),
    });
    const failed = final(await run("chat")).data as { error: { code: string; message: string } };
    expect(failed.error.code).toBe("LLM_MODEL_NOT_FOUND");
    expect(failed.error.message).toContain("Chat is set to use claude-nope, which Anthropic doesn't have");
  });

  it("sends a chat's next turn to the new model, keeping the history", async () => {
    const { send, run } = await setup();
    const first = await run("chat");
    const sessionId = (final(first).data as { sessionId: string }).sessionId;
    expect(final(first).data).toMatchObject({ provider: LOCAL, model: "small" });
    expect(chats().local).toHaveLength(1);

    await send("PUT", "/api/settings", {
      llm: { taskModels: { chat: { provider: "anthropic", model: CLAUDE } } },
    });
    reset();
    answer = "Still two slides.";
    const second = await sseEvents(
      await send("POST", "/api/ai/chat", { deckId, sessionId, message: "And now?" }),
    );
    expect(second[0]).toEqual({ event: "start", data: { provider: ANTHROPIC, model: CLAUDE } });
    expect(final(second).data).toMatchObject({ sessionId, provider: ANTHROPIC, model: CLAUDE });
    expect(chats().local).toHaveLength(0);
    const body = chats().anthropic[0]!.body!;
    const sent = JSON.stringify(body.messages) + JSON.stringify(body.system ?? "");
    expect(sent).toContain("How many slides?");
    expect(sent).toContain("It has two slides.");
    expect(sent).toContain("And now?");

    // …and back to local for the third turn.
    await send("PUT", "/api/settings", { llm: { taskModels: { chat: null } } });
    reset();
    const third = await sseEvents(
      await send("POST", "/api/ai/chat", { deckId, sessionId, message: "Thanks." }),
    );
    expect(final(third).data).toMatchObject({ sessionId, provider: LOCAL, model: "small" });
    expect(chats().anthropic).toHaveLength(0);
    expect(JSON.stringify(chats().local[0]!.body)).toContain("Still two slides.");
  });
});

describe("resolveTaskLlm", () => {
  const settings = (taskModels: TaskModels, extra: Partial<Settings> = {}): Settings => ({
    version: 1 as const,
    lastWorkspace: null,
    llm: {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "small",
      apiKey: "local-secret-key",
      temperature: 0.4,
      timeoutMs: 30_000,
      maxRepairRounds: 2,
      taskModels,
    },
    providers: [
      {
        id: "anthropic",
        kind: "anthropic" as const,
        label: "Claude",
        baseUrl: "https://a.test/v1",
        apiKey: ANTHROPIC_KEY,
      },
      {
        id: "openai",
        kind: "openai" as const,
        label: "OpenAI",
        baseUrl: "https://o.test/v1",
        apiKey: OPENAI_KEY,
      },
    ],
    ...extra,
  });

  it("uses the kind's default context length when the list reports none (D35)", async () => {
    const configs: unknown[] = [];
    const fake = new FakeProvider({ models: ["gpt-4o"] });
    const factory = (config: unknown) => (configs.push(config), fake);
    const signal = new AbortController().signal;

    const openaiRun = resolveTaskLlm(
      settings({ chat: { provider: "openai", model: "gpt-4o" } }),
      "chat",
      factory,
    );
    expect(openaiRun.providerInfo).toEqual(OPENAI);
    expect(openaiRun.maxTokens).toBe(4_096);
    expect(openaiRun.llm).toMatchObject({
      model: "gpt-4o",
      baseUrl: "https://o.test/v1",
      apiKey: null,
      temperature: 0.4,
    });
    expect(configs.at(-1)).toEqual({
      kind: "openai",
      baseUrl: "https://o.test/v1",
      apiKey: OPENAI_KEY,
      timeoutMs: 30_000,
    });
    expect((await openaiRun.provider.listModels(signal)).find((m) => m.id === "gpt-4o")?.contextLength).toBe(
      HOSTED_CONTEXT_LENGTH,
    );

    // A model the list doesn't show still gets the default; so does a list that fails.
    const claude = resolveTaskLlm(
      settings({ generate: { provider: "anthropic", model: CLAUDE } }),
      "generate",
      factory,
    );
    expect(claude.providerInfo).toEqual({ id: "anthropic", label: "Claude", kind: "anthropic" });
    expect(claude.maxTokens).toBe(8_192);
    expect((await claude.provider.listModels(signal)).find((m) => m.id === CLAUDE)?.contextLength).toBe(
      ANTHROPIC_CONTEXT_LENGTH,
    );
    fake.script = { models: { kind: "status", status: 500 } };
    expect(await claude.provider.listModels(signal)).toEqual([
      { id: CLAUDE, contextLength: ANTHROPIC_CONTEXT_LENGTH },
    ]);

    // Local models keep the budget's own default, and their list errors are the caller's.
    const localRun = resolveTaskLlm(settings({}), "rewrite", factory);
    expect(localRun.providerInfo).toEqual(LOCAL);
    expect(configs.at(-1)).toEqual({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "local-secret-key",
      timeoutMs: 30_000,
    });
    await expect(localRun.provider.listModels(signal)).rejects.toThrow();
  });

  it("passes the task with every chat request", async () => {
    const fake = new FakeProvider({ chat: [{ kind: "text", text: "ok" }] });
    const run = resolveTaskLlm(
      settings({ draft: { provider: "anthropic", model: CLAUDE } }),
      "draft",
      () => fake,
    );
    for await (const event of run.provider.chat({
      model: CLAUDE,
      messages: [],
      signal: new AbortController().signal,
    }))
      void event;
    expect(fake.requests[0]).toMatchObject({ task: "draft", model: CLAUDE });
  });

  it("runs a paid task without a local LLM, on the default bounds", () => {
    const run = resolveTaskLlm(
      { ...settings({}), llm: null, paidTaskModels: { chat: { provider: "anthropic", model: CLAUDE } } },
      "chat",
      () => new FakeProvider(),
    );
    expect(run.llm).toMatchObject({ model: CLAUDE, temperature: 0.2, maxRepairRounds: 1, timeoutMs: 60_000 });
    expect(() => resolveTaskLlm({ ...settings({}), llm: null }, "rewrite", () => new FakeProvider())).toThrow(
      expect.objectContaining({ code: "LLM_NOT_CONFIGURED" }),
    );
  });
});
