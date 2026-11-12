import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/server/settings.js";
import { sseEvents } from "../support/sse.js";
import { headers, makeApp, tempDir, write } from "../helpers.js";

// Runs only in the nightly workflow (vitest.real-llm.config.ts), against a real Ollama.
const BASE_URL = process.env.REAL_LLM_URL ?? "http://127.0.0.1:11434/v1";
const MODEL = process.env.REAL_LLM_MODEL ?? "qwen2.5:0.5b";

let home: string | undefined;
beforeAll(async () => {
  home = process.env.FLIPBOOK_HOME;
  const library = await tempDir("studio-lib-");
  // blueprint-talk as a media kit: a cover, three points, a conclusion.
  const blueprint = await fs.readFile(path.resolve("fixtures/ws/blueprint-talk/blueprint.yml"), "utf8");
  await write(library, {
    "templates/talk.yml": `name: talk\ndescription: A short talk.\ntemplates: {}\nblueprint:\n${blueprint
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}\n`,
  });
  process.env.FLIPBOOK_HOME = library;
});
afterAll(() => {
  if (home === undefined) delete process.env.FLIPBOOK_HOME;
  else process.env.FLIPBOOK_HOME = home;
});

describe("@real-llm generate", () => {
  it("@real-llm generates a blueprint-talk deck", async () => {
    const root = await tempDir();
    const settings = await SettingsStore.open(await tempDir(), () => {});
    await settings.update({
      llm: { baseUrl: BASE_URL, model: MODEL, timeoutMs: 120_000, maxRepairRounds: 2 },
    });
    const app = await makeApp(root, [], { settings });
    const response = await app.request("/api/ai/generate-deck", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "talk",
        title: "Why tests matter",
        kind: "folder",
        group: "talk",
        source: { topic: "Why automated tests matter" },
      }),
    });
    expect(response.status).toBe(200);
    const events = await sseEvents(response);
    const last = events.at(-1)!;
    expect(last.event, JSON.stringify(last.data)).toBe("done");
    expect(events.filter((event) => event.event === "slide").length).toBeGreaterThanOrEqual(3);
    await expect(fs.access(path.join(root, "talk", "presentation.yml"))).resolves.toBeUndefined();
  }, 600_000);
});
