import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { AI_TASKS, type AiTask, type TaskModels } from "../src/shared/api.js";
import { resetContextCache } from "../src/server/ai/budget.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-19 · 1.1.2: each AI route runs on its task's model, else the default (tech-spec D29, D30).

beforeEach(() => resetContextCache());

const deckId = encodeDeckId("deck");
const SLIDE = "slides/01.slide.md";
const FIXTURES: Record<AiTask | "file", LlmFixture> = {
  rewrite: { kind: "json", value: { markdown: "# First, shorter\n" } },
  generate: { kind: "text", text: `${JSON.stringify({ type: null, markdown: "# Cover" })}\n` },
  file: { kind: "text", text: `${JSON.stringify({ type: null, markdown: "# Notes" })}\n` },
  draft: {
    kind: "json",
    value: {
      css: ":host { --slide-bg: #101820; --slide-text: #f2f2f2; --slide-muted: #a0a8b0; --slide-accent: #ffb000; --slide-mint: #6fe3c1; --slide-heading: #fff; --slide-line: #2a3440; --slide-code: #0b1116; }",
    },
  },
  chat: { kind: "text", text: "It has two slides." },
};

async function setup(taskModels: TaskModels | undefined, gone: string[] = []) {
  const root = await tempDir();
  await write(
    root,
    Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`deck/${name}`, body])),
  );
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({
    llm: {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "default-model",
      maxRepairRounds: 0,
      ...(taskModels ? { taskModels } : {}),
    },
  });
  let current: LlmFixture = FIXTURES.chat;
  const fake = new FakeProvider({
    models: ["default-model", "small", "big"],
    chat: (request) => (gone.includes(request.model) ? { kind: "status", status: 404 } : current),
  });
  const app = await makeApp(root, [], { settings, llmProvider: () => fake });
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const upload = async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.from("# Notes\n\n## One\n\nx\n")], "notes.md"));
    const response = await app.request("/api/sources", { method: "POST", headers: headers(), body: form });
    return (await response.json()).source.sourceId as string;
  };
  /** Runs one task and returns its events and the models the provider was asked for. */
  const run = async (task: AiTask | "file") => {
    current = FIXTURES[task];
    fake.requests.length = 0;
    const hash = hashBytes(await fs.readFile(path.join(root, "deck", SLIDE)));
    const name = `deck-${Math.random().toString(36).slice(2, 8)}`;
    const response = await {
      rewrite: () =>
        post("/api/ai/rewrite", { deckId, slideId: SLIDE, baseHash: hash, instruction: { kind: "shorten" } }),
      generate: () =>
        post("/api/ai/generate-deck", {
          name,
          title: "T",
          kind: "folder",
          group: null,
          source: { topic: "Indexes" },
        }),
      file: async () =>
        post("/api/ai/generate-deck", {
          name,
          title: "T",
          kind: "folder",
          group: null,
          source: { sourceId: await upload() },
        }),
      draft: () => post("/api/ai/draft-kit", { kind: "theme", name: `t-${name}`, description: "Calm." }),
      chat: () => post("/api/ai/chat", { deckId, sessionId: null, message: "How many slides?" }),
    }[task]();
    const events = await sseEvents(response);
    return { events, models: [...new Set(fake.requests.map((request) => request.model))] };
  };
  return { run };
}

const done = (events: { event: string; data: unknown }[]) =>
  events.find((event) => event.event === "done")?.data as { model?: string } | undefined;

describe("model per AI task", () => {
  it("uses the default model for every task when none is set", async () => {
    const { run } = await setup(undefined);
    for (const task of [...AI_TASKS, "file"] as const) {
      const { events, models } = await run(task);
      expect(models, task).toEqual(["default-model"]);
      expect(done(events)?.model, task).toBe("default-model");
    }
  });

  it("uses each task's own model, and the default for the rest", async () => {
    const { run } = await setup({ rewrite: "small", generate: "big", chat: "big" });
    const expected = { rewrite: "small", generate: "big", file: "big", draft: "default-model", chat: "big" };
    for (const [task, model] of Object.entries(expected) as [AiTask | "file", string][]) {
      const { events, models } = await run(task);
      expect(models, task).toEqual([model]);
      expect(done(events)?.model, task).toBe(model);
    }
  });

  it("fails only the task whose model is gone, naming the task and the model", async () => {
    const { run } = await setup({ chat: "gone-model" }, ["gone-model"]);
    const chat = await run("chat");
    const failed = (
      chat.events.find((event) => event.event === "failed")!.data as {
        error: { code: string; message: string };
      }
    ).error;
    expect(failed.code).toBe("LLM_MODEL_NOT_FOUND");
    expect(failed.message).toContain("Chat is set to use gone-model");
    expect(failed.message).toContain("Model for each task");
    const rewrite = await run("rewrite");
    expect(done(rewrite.events)?.model).toBe("default-model");
  });
});
