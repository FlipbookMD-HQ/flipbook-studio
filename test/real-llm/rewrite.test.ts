import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { encodeDeckId } from "../../src/server/paths.js";
import { SettingsStore } from "../../src/server/settings.js";
import { sseEvents } from "../support/sse.js";
import { SINGLE_DECK, headers, makeApp, tempDir, write } from "../helpers.js";

// Runs only in the nightly workflow (vitest.real-llm.config.ts), against a real Ollama.
const BASE_URL = process.env.REAL_LLM_URL ?? "http://127.0.0.1:11434/v1";
const MODEL = process.env.REAL_LLM_MODEL ?? "qwen2.5:0.5b";

describe("@real-llm rewrite", () => {
  it("@real-llm shortens a slide into a valid proposal", async () => {
    const root = await tempDir();
    await write(root, { "talk.slide.md": SINGLE_DECK });
    const settings = await SettingsStore.open(await tempDir(), () => {});
    await settings.update({ llm: { baseUrl: BASE_URL, model: MODEL, timeoutMs: 120_000 } });
    const app = await makeApp(root, [], { settings });
    const baseHash = hashBytes(await fs.readFile(path.join(root, "talk.slide.md")));
    const response = await app.request("/api/ai/rewrite", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        deckId: encodeDeckId("talk.slide.md"),
        slideId: "#0",
        baseHash,
        instruction: { kind: "shorten" },
      }),
    });
    expect(response.status).toBe(200);
    const events = await sseEvents(response);
    const last = events.at(-1)!;
    expect(last.event, JSON.stringify(last.data)).toBe("done");
    const proposal = events.find((event) => event.event === "proposal");
    if (proposal) expect(proposal.data.ops[0].draft.markdown.length).toBeGreaterThan(0);
  }, 180_000);
});
