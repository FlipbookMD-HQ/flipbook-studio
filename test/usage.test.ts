import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { UsageResponseSchema, type TaskModels } from "../src/shared/api.js";
import { resetContextCache } from "../src/server/ai/budget.js";
import { UsageMeter, UsageTally } from "../src/server/ai/usage.js";
import { resetResponseFormatMemory, resetStreamOptionsMemory } from "../src/server/llm/provider.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { recordedText } from "./support/anthropic-fixtures.js";
import { startAnthropicStub, type AnthropicStub } from "./support/anthropic-stub.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture } from "./support/llm-fixtures.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";
import { sseEvents } from "./support/sse.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-25 · 1.1.1: tokens per paid run (summed over repair rounds) and the session totals behind
// GET /api/usage, on the fake Anthropic and OpenAI servers. No real network.
const ANTHROPIC_KEY = "sk-ant-api03-usage-tests-a1b2";
const OPENAI_KEY = "sk-proj-usage-tests-openai-c3d4";
const ANTHROPIC = { id: "anthropic", label: "Anthropic", kind: "anthropic" } as const;
const OPENAI = { id: "openai", label: "OpenAI", kind: "openai" } as const;
const CLAUDE = { provider: "anthropic", model: "claude-sonnet-4-5" };
const GPT = { provider: "openai", model: "gpt-4o" };
const deckId = encodeDeckId("deck");
const SLIDE = "slides/01.slide.md";
const REWRITE = JSON.stringify({ markdown: "# First, shorter\n" });

const COVER = { type: "cover", markdown: "# Reading guide\n\n![Hero](image.png)\n\nWhere to start." };
const timeline = (n: number, items = 2) => ({
  type: "timeline",
  markdown: `# Phase ${n}\n\n${Array.from({ length: items }, (_, i) => `- Stop ${i + 1}`).join("\n")}`,
});
const jsonLines = (...slides: object[]) => `${slides.map((slide) => JSON.stringify(slide)).join("\n")}\n`;

let local: LlmStub;
let openai: LlmStub;
let anthropic: AnthropicStub;
const env = {
  anthropic: process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL,
  openai: process.env.FLIPBOOK_STUDIO_OPENAI_URL,
};
/** What the OpenAI and local fakes answer next. */
let openaiAnswer: LlmFixture = { kind: "text", text: REWRITE, usage: { prompt: 40, completion: 9 } };

beforeEach(async () => {
  resetContextCache();
  resetResponseFormatMemory();
  resetStreamOptionsMemory();
  openaiAnswer = { kind: "text", text: REWRITE, usage: { prompt: 40, completion: 9 } };
  local = await startLlmStub({
    script: {
      models: ["small"],
      chat: () => ({ kind: "text", text: REWRITE, usage: { prompt: 7, completion: 3 } }),
    },
  });
  openai = await startLlmStub({
    script: { apiKey: OPENAI_KEY, models: ["gpt-4o"], chat: () => openaiAnswer },
  });
  anthropic = await startAnthropicStub({
    apiKey: ANTHROPIC_KEY,
    chat: () => ({ kind: "stream", events: recordedText(REWRITE, { input: 120, output: 30 }) }),
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
  const app = await makeApp(root, [], { settings });
  const send = (method: string, url: string, body?: unknown, signal?: AbortSignal) =>
    app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  await send("PUT", "/api/settings", { llm: { baseUrl: local.url, model: "small", maxRepairRounds } });
  expect((await send("POST", "/api/providers", { kind: "anthropic", apiKey: ANTHROPIC_KEY })).status).toBe(
    201,
  );
  expect((await send("POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY })).status).toBe(201);
  if (taskModels) expect((await send("PUT", "/api/settings", { llm: { taskModels } })).status).toBe(200);
  const rewrite = async (signal?: AbortSignal) => {
    const hash = hashBytes(await fs.readFile(path.join(root, "deck", SLIDE)));
    return send(
      "POST",
      "/api/ai/rewrite",
      { deckId, slideId: SLIDE, baseHash: hash, instruction: { kind: "shorten" } },
      signal,
    );
  };
  const usage = async () => {
    const response = await send("GET", "/api/usage");
    expect(response.status).toBe(200);
    return UsageResponseSchema.parse(await response.json());
  };
  return { app, send, rewrite, usage };
}

/** Reads an SSE response event by event: `until` stops at the first match, `rest` reads to the end. */
function sseReader(response: Response) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const seen: { event: string; data: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let index = 0;
  const pull = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      seen.push({
        event: /^event: (.*)$/m.exec(block)?.[1] ?? "message",
        data: data ? JSON.parse(data) : null,
      });
    }
    return true;
  };
  return {
    async until(event: string) {
      for (;;) {
        while (index < seen.length) if (seen[index++]!.event === event) return seen[index - 1]!;
        if (!(await pull())) throw new Error(`The stream ended before ${event}.`);
      }
    },
    async rest() {
      while (await pull());
      return seen;
    },
  };
}

const waitFor = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("GET /api/usage", () => {
  it("starts empty in a new server instance, with its start time", async () => {
    const before = Date.now();
    const { usage } = await setup();
    const view = await usage();
    expect(view.totals).toEqual([]);
    expect(Date.parse(view.since)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(view.since)).toBeLessThanOrEqual(Date.now());
  });

  it("is per server instance: a second Studio starts from nothing", async () => {
    const first = await setup({ rewrite: CLAUDE });
    await sseEvents(await first.rewrite());
    expect((await first.usage()).totals).toHaveLength(1);
    const second = await setup({ rewrite: CLAUDE });
    expect((await second.usage()).totals).toEqual([]);
  });

  it("needs the token like every API route", async () => {
    const { app } = await setup();
    const response = await app.request("/api/usage", { headers: headers({ "x-flipbook-token": null }) });
    expect(response.status).toBe(403);
  });
});

describe("usage of AI runs", () => {
  it("adds nothing for a local run, and its done carries usage: null", async () => {
    const { rewrite, usage } = await setup();
    const events = await sseEvents(await rewrite());
    expect(events.map((event) => event.event)).not.toContain("usage");
    expect(events.at(-1)).toMatchObject({ event: "done", data: { usage: null } });
    expect((await usage()).totals).toEqual([]);
  });

  it("reports a paid run's tokens in done and counts them for its provider", async () => {
    const { rewrite, usage } = await setup({ rewrite: CLAUDE });
    const events = await sseEvents(await rewrite());
    expect(events.at(-1)).toMatchObject({
      event: "done",
      data: { provider: ANTHROPIC, usage: { input: 120, output: 30 } },
    });
    // The progress events grow to the same total: input first (message_start), then output.
    const progress = events.filter((event) => event.event === "usage").map((event) => event.data.usage);
    expect(progress[0]).toEqual({ input: 120, output: 1 });
    expect(progress.at(-1)).toEqual({ input: 120, output: 30 });
    const view = await usage();
    expect(view.totals).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        requests: 1,
        input: 120,
        output: 30,
        unreported: 0,
      },
    ]);
    // Tokens only: never a price or an estimate.
    expect(JSON.stringify(view)).not.toMatch(/price|cost|usd|\$/i);
  });

  it("sums usage over generate's repair rounds into one task total", async () => {
    const { send, usage } = await setup({ generate: CLAUDE });
    anthropic.setScript({
      apiKey: ANTHROPIC_KEY,
      chat: [
        {
          kind: "stream",
          events: recordedText(jsonLines(COVER, timeline(1), timeline(2, 7)), { input: 1_000, output: 200 }),
        },
        { kind: "stream", events: recordedText(JSON.stringify(timeline(2)), { input: 1_300, output: 50 }) },
      ],
    });
    const events = await sseEvents(
      await send("POST", "/api/ai/generate-deck", {
        name: "guide",
        title: "Reading guide",
        kind: "folder",
        group: "marvel_content_guide",
        source: { topic: "Indexes" },
      }),
    );
    expect(events.map((event) => event.event)).toContain("repair");
    expect(events.at(-1)).toMatchObject({
      event: "done",
      data: { provider: ANTHROPIC, usage: { input: 2_300, output: 250 } },
    });
    expect((await usage()).totals).toEqual([
      expect.objectContaining({
        providerId: "anthropic",
        requests: 1,
        input: 2_300,
        output: 250,
        unreported: 0,
      }),
    ]);
  });

  it("keeps separate totals for two providers, shared by every request (two tabs)", async () => {
    const { rewrite, send, usage } = await setup({ rewrite: CLAUDE, chat: GPT });
    await sseEvents(await rewrite());
    openaiAnswer = { kind: "text", text: "It has two slides.", usage: { prompt: 40, completion: 9 } };
    const chat = await sseEvents(
      await send("POST", "/api/ai/chat", { deckId, sessionId: null, message: "How many slides?" }),
    );
    expect(chat.at(-1)).toMatchObject({
      event: "done",
      data: { provider: OPENAI, usage: { input: 40, output: 9 } },
    });
    await sseEvents(await rewrite());
    expect((await usage()).totals).toEqual([
      {
        providerId: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        requests: 2,
        input: 240,
        output: 60,
        unreported: 0,
      },
      {
        providerId: "openai",
        label: "OpenAI",
        kind: "openai",
        requests: 1,
        input: 40,
        output: 9,
        unreported: 0,
      },
    ]);
  });

  it("counts a paid run whose provider sent no usage as unreported, with usage: null", async () => {
    const { rewrite, usage } = await setup({ rewrite: GPT });
    openaiAnswer = { kind: "text", text: REWRITE };
    const events = await sseEvents(await rewrite());
    expect(events.at(-1)).toMatchObject({ event: "done", data: { provider: OPENAI, usage: null } });
    expect((await usage()).totals).toEqual([
      expect.objectContaining({ providerId: "openai", requests: 1, input: 0, output: 0, unreported: 1 }),
    ]);
  });

  it("gives usage: null and unreported + 1 when cancelled before message_start", async () => {
    const { rewrite, usage } = await setup({ rewrite: CLAUDE });
    anthropic.setScript({ apiKey: ANTHROPIC_KEY, chat: [{ kind: "hang" }] });
    const abort = new AbortController();
    const stream = sseReader(await rewrite(abort.signal));
    await stream.until("start");
    await waitFor(() => anthropic.requests.some((request) => request.path === "/v1/messages"));
    abort.abort();
    const events = await stream.rest();
    expect(events.map((event) => event.event)).not.toContain("usage");
    expect(events.at(-1)).toMatchObject({
      event: "failed",
      data: { error: { code: "CANCELLED" }, provider: ANTHROPIC, usage: null },
    });
    expect((await usage()).totals).toEqual([
      expect.objectContaining({ providerId: "anthropic", requests: 1, input: 0, output: 0, unreported: 1 }),
    ]);
  });

  it("keeps the usage reported so far when cancelled after message_start", async () => {
    const { rewrite, usage } = await setup({ rewrite: CLAUDE });
    // message_start comes at once; the text after it is far too slow to finish.
    const events = recordedText(`${"word ".repeat(50)}\n`, { input: 120, output: 30 });
    anthropic.setScript({ apiKey: ANTHROPIC_KEY, chat: [{ kind: "stream", events, delayMs: 200 }] });
    const abort = new AbortController();
    const stream = sseReader(await rewrite(abort.signal));
    const progress = await stream.until("usage");
    expect(progress.data).toEqual({ usage: { input: 120, output: 1 } });
    abort.abort();
    const all = await stream.rest();
    expect(all.at(-1)).toMatchObject({
      event: "failed",
      data: { error: { code: "CANCELLED" }, provider: ANTHROPIC, usage: { input: 120, output: 1 } },
    });
    expect((await usage()).totals).toEqual([
      expect.objectContaining({ providerId: "anthropic", requests: 1, input: 120, output: 1, unreported: 0 }),
    ]);
  });

  it("carries the usage reported so far in failed", async () => {
    const { rewrite, usage } = await setup({ rewrite: GPT });
    // Not JSON twice: both rounds are billed, then the run fails with LLM_BAD_OUTPUT.
    openaiAnswer = { kind: "text", text: "Sorry, I can't.", usage: { prompt: 40, completion: 4 } };
    const events = await sseEvents(await rewrite());
    expect(events.at(-1)).toMatchObject({
      event: "failed",
      data: { error: { code: "LLM_BAD_OUTPUT" }, provider: OPENAI, usage: { input: 80, output: 8 } },
    });
    expect((await usage()).totals).toEqual([
      expect.objectContaining({ providerId: "openai", requests: 1, input: 80, output: 8, unreported: 0 }),
    ]);
  });

  it("doesn't count a paid run that failed before sending any request", async () => {
    const { send, usage } = await setup({ rewrite: CLAUDE });
    // A slide that doesn't exist fails before the provider is asked anything.
    const response = await send("POST", "/api/ai/rewrite", {
      deckId,
      slideId: SLIDE,
      baseHash: "0".repeat(64),
      instruction: { kind: "shorten" },
    });
    if (response.headers.get("content-type")?.includes("event-stream")) await sseEvents(response);
    expect(anthropic.requests.filter((request) => request.path === "/v1/messages")).toHaveLength(0);
    expect((await usage()).totals).toEqual([]);
  });
});

describe("UsageMeter and UsageTally", () => {
  it("ignores local runs and keeps a provider's latest label", () => {
    const meter = new UsageMeter();
    meter.record({ id: "local", label: "Local", kind: "local" }, { input: 5, output: 5 });
    expect(meter.view().totals).toEqual([]);
    meter.record(
      { id: "openrouter", label: "openrouter", kind: "openai-compatible" },
      { input: 1, output: 2 },
    );
    meter.record({ id: "openrouter", label: "Router", kind: "openai-compatible" }, null);
    expect(meter.view().totals).toEqual([
      {
        providerId: "openrouter",
        label: "Router",
        kind: "openai-compatible",
        requests: 2,
        input: 1,
        output: 2,
        unreported: 1,
      },
    ]);
  });

  it("sums each request's last report, and settles into the meter once", async () => {
    const meter = new UsageMeter();
    const tally = new UsageTally(ANTHROPIC, meter);
    const fake = new FakeProvider({
      chat: [
        { kind: "text", text: "a", usage: { prompt: 10, completion: 2 } },
        { kind: "text", text: "b" },
        { kind: "text", text: "c", usage: { prompt: 15, completion: 3 } },
      ],
    });
    const provider = tally.wrap(fake);
    const seen: unknown[] = [];
    tally.onChange((usage) => seen.push(usage));
    expect(tally.current()).toBeNull();
    for (let i = 0; i < 3; i++)
      for await (const event of provider.chat({
        model: "m",
        messages: [],
        signal: new AbortController().signal,
      }))
        void event;
    expect(tally.current()).toEqual({ input: 25, output: 5 });
    expect(seen).toEqual([
      { input: 10, output: 2 },
      { input: 25, output: 5 },
    ]);
    expect(tally.settle()).toEqual({ input: 25, output: 5 });
    expect(tally.settle()).toEqual({ input: 25, output: 5 });
    expect(meter.view().totals).toEqual([expect.objectContaining({ requests: 1, input: 25, output: 5 })]);
  });

  it("passes onUsage through to the caller as well", async () => {
    const tally = new UsageTally(OPENAI, new UsageMeter());
    const inner = {
      listModels: async () => [],
      async *chat(request: { onUsage?: (usage: { prompt: number; completion: number }) => void }) {
        request.onUsage?.({ prompt: 3, completion: 0 });
        request.onUsage?.({ prompt: 3, completion: 4 });
        yield { type: "done" as const };
      },
    };
    const calls: unknown[] = [];
    for await (const event of tally.wrap(inner).chat({
      model: "m",
      messages: [],
      signal: new AbortController().signal,
      onUsage: (usage) => calls.push(usage),
    }))
      void event;
    expect(calls).toEqual([
      { prompt: 3, completion: 0 },
      { prompt: 3, completion: 4 },
    ]);
    expect(tally.current()).toEqual({ input: 3, output: 4 });
  });
});
