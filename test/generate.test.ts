import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPresentation, normalizeBlueprint } from "@flipbook-md/core";
import { resetContextCache } from "../src/server/ai/budget.js";
import { generateMessages } from "../src/server/ai/prompts/generate-deck.js";
import { launch } from "../src/server/launcher.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { TMP_DIR } from "../src/server/workspace.js";
import {
  AiFailedEventSchema,
  AiStartEventSchema,
  GenerateDoneEventSchema,
  GenerateNoticeEventSchema,
  GenerateRepairEventSchema,
  GenerateSlideEventSchema,
} from "../src/shared/api.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture, LlmScript } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

// marvel_content_guide (built in): a cover with a heading and an image, then 0-12 timeline pages
// with a heading, a list and at most five items.
const KIT = "marvel_content_guide";
const COVER = { type: "cover", markdown: "# Reading guide\n\n![Hero](image.png)\n\nWhere to start." };
const timeline = (n: number, items = 2) => ({
  type: "timeline",
  markdown: `# Phase ${n}\n\n${Array.from({ length: items }, (_, i) => `- Stop ${i + 1}`).join("\n")}`,
});
const lines = (...slides: object[]): LlmFixture => ({
  kind: "text",
  text: `Here you go:\n${slides.map((slide) => JSON.stringify(slide)).join("\n")}\n`,
});
const SCHEMAS: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {
  start: AiStartEventSchema,
  slide: GenerateSlideEventSchema,
  repair: GenerateRepairEventSchema,
  notice: GenerateNoticeEventSchema,
  done: GenerateDoneEventSchema,
  failed: AiFailedEventSchema,
};

beforeEach(() => resetContextCache());

async function setup(script: LlmScript, maxRepairRounds = 1) {
  const root = await tempDir();
  await write(root, { "existing.slide.md": "# Hello\n" });
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({ llm: { baseUrl: "http://127.0.0.1:9/v1", model: "stub-model", maxRepairRounds } });
  const fake = new FakeProvider(script);
  const app = await makeApp(root, [], { settings, llmProvider: () => fake });
  const post = (url: string, body: unknown, init: RequestInit = {}) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      ...init,
    });
  const generate = (extra: object = {}, init: RequestInit = {}) =>
    post(
      "/api/ai/generate-deck",
      {
        name: "guide",
        title: "Reading guide",
        kind: "folder",
        group: KIT,
        source: { topic: "Marvel films" },
        ...extra,
      },
      init,
    );
  return { root, fake, post, generate, listing: () => fs.readdir(root).then((names) => names.sort()) };
}

async function events(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  const list = await sseEvents(response);
  for (const { event, data } of list) expect(SCHEMAS[event]!.safeParse(data).success, event).toBe(true);
  return list;
}

const LOCAL = { id: "local", label: "Local", kind: "local" };
const names = (list: { event: string }[]) => list.map((item) => item.event);

describe("generate-deck prompt", () => {
  const blueprint = normalizeBlueprint(
    {
      pages: [{ type: "cover" }, { any: ["point", "quote"], repeat: { min: 2, max: 4 } }, { type: "end" }],
      types: {
        cover: { template: "cover", require: ["heading"] },
        point: { max_items: 3 },
        quote: { allow: ["blockquote"] },
        end: { max_chars: 200 },
      },
    },
    {},
  );
  it("builds a topic prompt", () => {
    expect(
      generateMessages({
        title: "Talk",
        blueprint,
        templates: ["cover", "summary"],
        source: { topic: "Caching" },
      }).messages,
    ).toMatchSnapshot();
  });
  it("builds a text prompt that keeps facts, order and language", () => {
    const { messages } = generateMessages({
      title: "Talk",
      blueprint: null,
      templates: [],
      source: { text: "Primeiro. Segundo." },
    });
    expect(messages[1]!.content).toContain("Keep its facts, its order and its language");
    expect(messages).toMatchSnapshot();
  });
  it("describes any: and repeat ranges, and trims a long source", () => {
    const { messages, trimmed } = generateMessages(
      { title: "Talk", blueprint, templates: [], source: { text: "x".repeat(100) }, language: "Spanish" },
      10,
    );
    expect(trimmed).toBe(true);
    expect(messages[1]!.content).toContain('any of the types "point", "quote": 2 to 4 slides');
    expect(messages[1]!.content).toContain("Write every slide and note in Spanish.");
    expect(messages).toMatchSnapshot();
  });
});

describe("POST /api/ai/generate-deck", () => {
  it("streams slides then done when the deck passes on the first try", async () => {
    const { generate, root, fake } = await setup({ chat: [lines(COVER, timeline(1), timeline(2))] });
    const list = await events(await generate());
    expect(names(list)).toEqual(["start", "slide", "slide", "slide", "done"]);
    expect(list[2]!.data).toMatchObject({ index: 1, draft: { type: "timeline" } });
    expect(list.at(-1)!.data).toEqual({
      deckId: encodeDeckId("guide"),
      violations: [],
      model: "stub-model",
      provider: LOCAL,
    });
    const { presentation, violations } = await loadPresentation(path.join(root, "guide"), {
      blueprint: "evaluate",
    });
    expect(presentation.slides.map((slide) => slide.type)).toEqual(["cover", "timeline", "timeline"]);
    expect(violations).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    await expect(fs.access(path.join(root, TMP_DIR))).rejects.toThrow();
  });

  it("repairs only the failing slide", async () => {
    const { generate, fake } = await setup({
      chat: [lines(COVER, timeline(1), timeline(2, 7)), { kind: "json", value: timeline(2) }],
    });
    const list = await events(await generate());
    expect(names(list)).toEqual(["start", "slide", "slide", "slide", "repair", "done"]);
    expect(list[4]!.data.violations).toEqual([expect.objectContaining({ code: "MAX_ITEMS" })]);
    expect(list.at(-1)!.data.violations).toEqual([]);
    expect(fake.requests).toHaveLength(2);
    const repair = fake.requests[1]!.messages.at(-1)!.content;
    expect(repair).toContain("# Phase 2");
    expect(repair).not.toContain("# Phase 1");
    expect(repair).not.toContain("Reading guide\n\n![Hero]");
  });

  it("fixes the order with one sequence repair, keeping existing slides", async () => {
    const { generate, root, fake } = await setup({
      chat: [lines(timeline(1), COVER), { kind: "text", text: '{"keep": 1}\n{"keep": 0}\n' }],
    });
    const list = await events(await generate());
    expect(names(list)).toEqual(["start", "slide", "slide", "repair", "done"]);
    expect(list[3]!.data.violations.map((violation: { code: string }) => violation.code)).toContain("ORDER");
    expect(list.at(-1)!.data.violations).toEqual([]);
    const { presentation } = await loadPresentation(path.join(root, "guide"), { blueprint: "evaluate" });
    expect(presentation.slides.map((slide) => slide.title)).toEqual(["Reading guide", "Phase 1"]);
    expect(fake.requests).toHaveLength(2);
  });

  it("saves the deck with its violations when repairs run out", async () => {
    const { generate, root } = await setup({
      chat: [lines(COVER, timeline(1, 8)), { kind: "json", value: timeline(1, 9) }],
    });
    const list = await events(await generate());
    expect(names(list)).toEqual(["start", "slide", "slide", "repair", "done"]);
    expect(list.at(-1)!.data.violations).toEqual([expect.objectContaining({ code: "MAX_ITEMS" })]);
    await expect(fs.access(path.join(root, "guide", "presentation.yml"))).resolves.toBeUndefined();
  });

  it("makes no repair round when maxRepairRounds is 0", async () => {
    const { generate } = await setup({ chat: [lines(COVER, timeline(1, 8))] }, 0);
    const list = await events(await generate());
    expect(names(list)).toEqual(["start", "slide", "slide", "done"]);
  });

  it("writes a single-file deck too", async () => {
    const { generate, root } = await setup({
      chat: [lines(timeline(1), COVER), { kind: "text", text: '{"keep":1}\n{"keep":0}\n' }],
    });
    const list = await events(await generate({ kind: "single" }));
    expect(list.at(-1)!.data).toEqual({
      deckId: encodeDeckId("guide.slide.md"),
      violations: [],
      model: "stub-model",
      provider: LOCAL,
    });
    const text = await fs.readFile(path.join(root, "guide.slide.md"), "utf8");
    expect(text.indexOf("# Reading guide")).toBeLessThan(text.indexOf("# Phase 1"));
  });

  for (const stage of ["stream", "repair"] as const) {
    it(`leaves no residue when cancelled mid-${stage}`, async () => {
      const chat: LlmFixture[] =
        stage === "stream"
          ? [
              {
                kind: "slowTokens",
                ms: 30,
                text: `${JSON.stringify(COVER)}\n${JSON.stringify(timeline(1))}\n`,
              },
            ]
          : [lines(COVER, timeline(1, 9)), { kind: "hang" }];
      const { generate, listing, root } = await setup({ chat });
      const before = await listing();
      const client = new AbortController();
      const response = await generate({}, { signal: client.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let seen = "";
      while (!seen.includes(stage === "stream" ? "event: slide" : "event: repair")) {
        const next = await reader.read();
        if (next.done) throw new Error(`Stream ended early: ${seen}`);
        seen += next.value;
      }
      expect(await fs.readdir(path.join(root, TMP_DIR))).toHaveLength(1);
      client.abort();
      void reader.cancel().catch(() => {});
      for (let i = 0; i < 50 && (await listing()).length !== before.length; i += 1)
        await new Promise((r) => setTimeout(r, 20));
      expect(await listing()).toEqual(before);
    });
  }

  it("keeps the deck when the name is taken at publish time, then Save as publishes it", async () => {
    let root = "";
    const {
      generate,
      post,
      root: workspace,
    } = await setup({
      chat: () => {
        void fs.mkdir(path.join(root, "guide"));
        return lines(COVER, timeline(1));
      },
    });
    root = workspace;
    const list = await events(await generate());
    const failed = list.at(-1)!;
    expect(failed).toMatchObject({
      event: "failed",
      data: { error: { code: "DECK_EXISTS", details: { runId: expect.any(String) } } },
    });
    const runId = failed.data.error.details.runId;
    await expect(fs.readdir(path.join(root, TMP_DIR))).resolves.toEqual([runId]);

    const taken = await post(`/api/ai/generate-deck/${runId}/save-as`, { name: "guide" });
    expect(taken.status).toBe(409);
    const saved = await post(`/api/ai/generate-deck/${runId}/save-as`, { name: "guide-2" });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ deckId: encodeDeckId("guide-2") });
    await expect(fs.access(path.join(root, "guide-2", "presentation.yml"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, TMP_DIR))).rejects.toThrow();
    expect((await post(`/api/ai/generate-deck/${runId}/save-as`, { name: "guide-3" })).status).toBe(404);
  });

  it("adds the temp folder to .gitignore in a git workspace", async () => {
    const { generate, root } = await setup({ chat: [lines(COVER, timeline(1))] });
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules");
    await events(await generate());
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(`node_modules\n${TMP_DIR}/\n`);
    await events(await generate({ name: "again" }));
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(`node_modules\n${TMP_DIR}/\n`);
  });

  it("checks before streaming: 422, 409 DECK_EXISTS, 404 KIT_NOT_FOUND, 413 and LLM_NOT_CONFIGURED", async () => {
    const { generate } = await setup({ chat: [lines(COVER)] });
    const status = async (response: Response) => [response.status, (await response.json()).error.code];
    expect(await status(await generate({ source: {} }))).toEqual([422, "VALIDATION_FAILED"]);
    expect(await status(await generate({ name: "existing", kind: "single" }))).toEqual([409, "DECK_EXISTS"]);
    expect(await status(await generate({ group: "no-such-kit" }))).toEqual([404, "KIT_NOT_FOUND"]);
    expect(await status(await generate({ source: { text: "a".repeat(200_001) } }))).toEqual([
      413,
      "PAYLOAD_TOO_LARGE",
    ]);

    const root = await tempDir();
    const app = await makeApp(root, [], { settings: await SettingsStore.open(await tempDir(), () => {}) });
    const response = await app.request("/api/ai/generate-deck", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "x", title: "X", kind: "folder", group: null, source: { topic: "t" } }),
    });
    expect(await status(response)).toEqual([409, "LLM_NOT_CONFIGURED"]);
  });

  it("fails with LLM_BAD_OUTPUT and leaves nothing when no slide arrives", async () => {
    const { generate, listing } = await setup({ chat: [{ kind: "text", text: "Sorry, I can't." }] });
    const before = await listing();
    const list = await events(await generate());
    expect(list).toEqual([
      { event: "start", data: { provider: LOCAL, model: "stub-model" } },
      {
        event: "failed",
        data: { error: expect.objectContaining({ code: "LLM_BAD_OUTPUT" }), provider: LOCAL },
      },
    ]);
    expect(await listing()).toEqual(before);
  });
});

describe("startup", () => {
  let home: string | undefined;
  beforeEach(() => (home = process.env.FLIPBOOK_HOME));
  afterEach(() => {
    if (home === undefined) delete process.env.FLIPBOOK_HOME;
    else process.env.FLIPBOOK_HOME = home;
  });

  it("empties the temp folder a crash left behind", async () => {
    const workspace = await tempDir();
    await write(workspace, { [`${TMP_DIR}/run-1/guide/presentation.yml`]: "title: half\n" });
    const uiDir = await tempDir("studio-ui-");
    await write(uiDir, { "index.html": "<div></div>" });
    const launched = await launch(
      { workspace, port: 0, open: false, library: await tempDir("studio-lib-") },
      { log: () => {}, uiDir },
    );
    await launched.close();
    await expect(fs.access(path.join(workspace, TMP_DIR))).rejects.toThrow();
  });
});
