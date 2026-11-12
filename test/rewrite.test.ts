import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { resetContextCache } from "../src/server/ai/budget.js";
import { rewriteMessages, rewriteParts } from "../src/server/ai/prompts/rewrite.js";
import { resetResponseFormatMemory } from "../src/server/llm/provider.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import type { LlmScript } from "./support/llm-fixtures.js";
import type { RewriteInstruction, SlideDraft } from "../src/shared/api.js";
import { FakeProvider } from "./support/fake-provider.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";
import { sseEvents } from "./support/sse.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

const DECK = {
  "deck/presentation.yml":
    "title: Pitch\nslides:\n  - slides/01_cover.slide.md\n  - slides/02_body.slide.md\n",
  "deck/blueprint.yml":
    "pages:\n  - type: cover\n  - type: body\n    repeat: { min: 0, max: 9 }\ntypes:\n  cover:\n    max_chars: 40\n  body: {}\n",
  "deck/slides/01_cover.slide.md": "# Cover\n\nOur product saves time.\n",
  "deck/slides/02_body.slide.md": "# Second\n\nText.\n",
};
const SLIDE = "slides/01_cover.slide.md";
const deckId = encodeDeckId("deck");
const INSTRUCTIONS: RewriteInstruction[] = [
  { kind: "shorten" },
  { kind: "expand" },
  { kind: "translate", language: "Portuguese" },
  { kind: "custom", text: "Make it punchier" },
];

beforeEach(() => {
  resetContextCache();
  resetResponseFormatMemory();
});

async function setup(
  script: LlmScript,
  llm: { baseUrl?: string; timeoutMs?: number } = {},
  factory?: "http",
) {
  const root = await tempDir();
  await write(root, DECK);
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({
    llm: {
      baseUrl: llm.baseUrl ?? "http://127.0.0.1:9/v1",
      model: "stub-model",
      ...(llm.timeoutMs ? { timeoutMs: llm.timeoutMs } : {}),
    },
  });
  const fake = new FakeProvider(script);
  const app = await makeApp(root, [], { settings, ...(factory ? {} : { llmProvider: () => fake }) });
  const file = path.join(root, "deck", SLIDE);
  const hash = async () => hashBytes(await fs.readFile(file));
  const request = (url: string, body: unknown, method = "POST") =>
    app.request(url, {
      method,
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const rewrite = async (instruction: unknown, extra: object = {}) =>
    request("/api/ai/rewrite", { deckId, slideId: SLIDE, baseHash: await hash(), instruction, ...extra });
  return { root, app, fake, file, hash, request, rewrite };
}

const reply = (markdown: string, notes?: string): LlmScript => ({
  chat: [{ kind: "json", value: { markdown, ...(notes != null ? { notes } : {}) } }],
});

describe("rewrite prompt", () => {
  const draft: SlideDraft = {
    markdown: "# Cover\n\nOur product saves time.",
    template: null,
    type: "cover",
    notes: "Say hi.",
    title: null,
    directives: {},
  };
  for (const instruction of INSTRUCTIONS) {
    it(`builds the ${instruction.kind} prompt`, () => {
      const messages = rewriteMessages(
        rewriteParts({
          draft,
          rules: { max_chars: 40 },
          template: "title",
          deckTitle: "Pitch",
          deckLanguage: null,
          instruction,
        }),
      );
      expect(messages).toMatchSnapshot();
    });
  }
});

describe("POST /api/ai/rewrite", () => {
  it("streams tokens, then one updateSlide proposal, and writes nothing", async () => {
    for (const instruction of INSTRUCTIONS) {
      const { rewrite, file, fake } = await setup(reply("# Cover\n\nSaves time."));
      const before = await fs.readFile(file, "utf8");
      const response = await rewrite(instruction);
      expect(response.status).toBe(200);
      const events = await sseEvents(response);
      expect(events.filter((event) => event.event === "token").length).toBeGreaterThan(0);
      const proposal = events.find((event) => event.event === "proposal")!.data;
      expect(proposal.ops).toEqual([
        expect.objectContaining({
          kind: "updateSlide",
          slideId: SLIDE,
          draft: expect.objectContaining({ markdown: "# Cover\n\nSaves time.", type: "cover", notes: "" }),
          violations: [],
        }),
      ]);
      expect(events.at(-1)).toEqual({ event: "done", data: {} });
      expect(await fs.readFile(file, "utf8")).toBe(before);
      const prompt = fake.requests[0]!.messages.at(-1)!.content;
      if (instruction.kind === "translate") expect(prompt).toContain("Portuguese");
      if (instruction.kind === "custom") expect(prompt).toContain("Make it punchier");
    }
  });

  it("rejects translate without a language with 422", async () => {
    const { rewrite } = await setup(reply("x"));
    const response = await rewrite({ kind: "translate" });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("returns 409 LLM_NOT_CONFIGURED before streaming", async () => {
    const root = await tempDir();
    await write(root, DECK);
    const app = await makeApp(root, [], { settings: await SettingsStore.open(await tempDir(), () => {}) });
    const response = await app.request("/api/ai/rewrite", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        deckId,
        slideId: SLIDE,
        baseHash: "0".repeat(64),
        instruction: { kind: "shorten" },
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LLM_NOT_CONFIGURED");
  });

  it("returns 409 FILE_CONFLICT before streaming when the base hash is stale", async () => {
    const { request } = await setup(reply("x"));
    const response = await request("/api/ai/rewrite", {
      deckId,
      slideId: SLIDE,
      baseHash: "0".repeat(64),
      instruction: { kind: "shorten" },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("FILE_CONFLICT");
  });

  it("carries a MAX_CHARS violation on the proposal", async () => {
    const { rewrite } = await setup(
      reply("# Cover\n\nOur product saves time, money, effort and much, much more."),
    );
    const events = await sseEvents(await rewrite({ kind: "expand" }));
    const op = events.find((event) => event.event === "proposal")!.data.ops[0];
    expect(op.violations).toEqual([expect.objectContaining({ code: "MAX_CHARS", source: SLIDE })]);
  });

  it("passes the broken rules back on a retry", async () => {
    const { rewrite, fake } = await setup(reply("# Cover\n\nShort."));
    await sseEvents(await rewrite({ kind: "expand" }, { avoid: ["Slide is longer than 40 characters."] }));
    expect(fake.requests[0]!.messages.at(-1)!.content).toContain("Slide is longer than 40 characters.");
  });

  it("ends with done {noChange} when the answer is identical", async () => {
    const { rewrite } = await setup(reply("# Cover\n\nOur product saves time."));
    const events = await sseEvents(await rewrite({ kind: "shorten" }));
    expect(events.map((event) => event.event)).not.toContain("proposal");
    expect(events.at(-1)).toEqual({ event: "done", data: { noChange: true } });
  });

  it("ends with failed LLM_BAD_OUTPUT on empty output and leaves the slide alone", async () => {
    const { rewrite, file } = await setup({ chat: [{ kind: "text", text: "" }] });
    const before = await fs.readFile(file, "utf8");
    const events = await sseEvents(await rewrite({ kind: "shorten" }));
    expect(events.at(-1)).toMatchObject({ event: "failed", data: { error: { code: "LLM_BAD_OUTPUT" } } });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("keeps a hostile <script> reply as plain text; the preview sanitizes it", async () => {
    const { rewrite, request } = await setup(reply('# Cover\n\n<script>alert("x")</script> Hi'));
    const events = await sseEvents(await rewrite({ kind: "custom", text: "anything" }));
    const op = events.find((event) => event.event === "proposal")!.data.ops[0];
    expect(op.draft.markdown).toContain("<script>");
    const preview = await (
      await request(`/api/decks/${deckId}/preview`, { slideId: SLIDE, draft: op.draft })
    ).json();
    expect(preview.html).not.toContain('alert("x")');
  });

  it("applies the proposal, and rejects it as stale when the file changed first", async () => {
    const { rewrite, request, file } = await setup(reply("# Cover\n\nSaves time."));
    const first = (await sseEvents(await rewrite({ kind: "shorten" }))).find(
      (event) => event.event === "proposal",
    )!.data;
    const applied = await (await request(`/api/proposals/${first.id}/apply`, { opIds: ["op-1"] })).json();
    expect(applied).toMatchObject({ applied: ["op-1"], rejected: [] });
    expect(applied.hashes[SLIDE]).toBe(hashBytes(await fs.readFile(file)));
    expect(await fs.readFile(file, "utf8")).toContain("Saves time.");

    const second = (await sseEvents(await rewrite({ kind: "shorten" }))).find(
      (event) => event.event === "proposal",
    );
    expect(second).toBeUndefined(); // Same answer as the file now: no change.
  });

  it("marks the op stale when the slide changed on disk before accepting", async () => {
    const { rewrite, request, file } = await setup(reply("# Cover\n\nSaves time."));
    const proposal = (await sseEvents(await rewrite({ kind: "shorten" }))).find(
      (event) => event.event === "proposal",
    )!.data;
    await fs.writeFile(file, "# Cover\n\nEdited by hand.\n");
    const result = await (await request(`/api/proposals/${proposal.id}/apply`, { opIds: ["op-1"] })).json();
    expect(result.rejected).toEqual([expect.objectContaining({ opId: "op-1", code: "STALE_PROPOSAL" })]);
    expect(await fs.readFile(file, "utf8")).toBe("# Cover\n\nEdited by hand.\n");
  });
});

describe("POST /api/ai/rewrite against the HTTP stub", () => {
  let stub: LlmStub;
  beforeEach(async () => {
    stub = await startLlmStub();
  });
  afterEach(() => stub.close());

  it("times out with LLM_TIMEOUT and leaves the file untouched", async () => {
    stub.setScript({ chat: [{ kind: "hang" }] });
    const { rewrite, file } = await setup({}, { baseUrl: stub.url, timeoutMs: 5_000 }, "http");
    const before = await fs.readFile(file, "utf8");
    const events = await sseEvents(await rewrite({ kind: "shorten" }));
    expect(events.at(-1)).toMatchObject({ event: "failed", data: { error: { code: "LLM_TIMEOUT" } } });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  }, 20_000);

  it("uses the model's context length and says when it shortened the context", async () => {
    stub.setScript({
      models: ["stub-model"],
      chat: [{ kind: "json", value: { markdown: "# Cover\n\nShort." } }],
    });
    const { rewrite } = await setup({}, { baseUrl: stub.url }, "http");
    const events = await sseEvents(await rewrite({ kind: "shorten" }));
    expect(events.map((event) => event.event)).toContain("proposal");
    expect(events.map((event) => event.event)).not.toContain("notice");
  });
});
