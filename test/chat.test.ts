import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { resetContextCache, fit } from "../src/server/ai/budget.js";
import {
  ChatSessionStore,
  MAX_TURNS,
  ReplySplitter,
  buildDeckContext,
  historyParts,
  mentionedSlides,
  parseOps,
} from "../src/server/ai/chat.js";
import { CHAT_SYSTEM, chatMessages } from "../src/server/ai/prompts/chat.js";
import { findDeck, loadDeck } from "../src/server/decks.js";
import { resetResponseFormatMemory } from "../src/server/llm/provider.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
const talk = encodeDeckId("talk");
const S = (n: number) => `slides/0${n}_${n === 1 ? "cover" : n === 5 ? "conclusion" : "point"}.slide.md`;
const ops = (list: unknown) => `\n\`\`\`flipbook-ops\n${JSON.stringify(list)}\n\`\`\`\n`;

beforeEach(() => {
  resetContextCache();
  resetResponseFormatMemory();
});

async function workspace() {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  return root;
}

async function talkContext(message: string, openSlideId: string | null = null) {
  const root = await workspace();
  const deck = await findDeck(root, talk);
  const loaded = await loadDeck(deck);
  return { root, deck, context: await buildDeckContext(deck, loaded, { openSlideId, message }) };
}

describe("chat prompt and context", () => {
  it("snapshots the system prompt", () => {
    expect(CHAT_SYSTEM).toMatchSnapshot();
  });

  it("builds the blueprint-talk context", async () => {
    const { context } = await talkContext("What does this deck ask for?", S(2));
    expect(context.ids).toEqual([1, 2, 3, 4, 5].map(S));
    expect(chatMessages(context.parts, "What does this deck ask for?")).toMatchSnapshot();
  });

  it("pulls the full text of a mentioned slide", async () => {
    expect(mentionedSlides("Split slide 4 into two, and look at Slide #2")).toEqual([4, 2]);
    const { context } = await talkContext("Split slide 4 into two");
    const four = context.parts.find((part) => part.name === "slide-4")!;
    expect(four.text).toContain("Two options are enough. A third belongs in an appendix.");
    expect(context.parts.some((part) => part.name === "excerpt-4")).toBe(false);
    expect(context.parts.find((part) => part.name === "excerpt-3")!.text).toContain("Show the limit");
  });

  it("trims the oldest turns first, then excerpts, and never the slide list", async () => {
    const { context } = await talkContext("Hi");
    const turns = Array.from({ length: 4 }, (_, index) => ({
      user: `question ${index} ${"q".repeat(400)}`,
      assistant: `answer ${index} ${"a".repeat(400)}`,
    }));
    const parts = [...context.parts, ...historyParts(turns)];
    const total = parts.reduce((sum, part) => sum + part.text.length, 0);
    const names = (tokens: number) => fit(parts, tokens).parts.map((part) => part.name);

    // Just enough to lose two turns: the two oldest go.
    const twoTurns = Math.ceil((total - 2 * 820) / 0.8 / 4) + 1;
    expect(names(twoTurns)).toEqual(expect.arrayContaining(["turn-3", "turn-4", "excerpt-1"]));
    expect(names(twoTurns)).not.toContain("turn-1");
    expect(names(twoTurns)).not.toContain("turn-2");

    // A tiny budget drops every turn and excerpt but keeps the slide list.
    const tiny = names(50);
    expect(tiny).toContain("slides");
    expect(tiny.some((name) => name.startsWith("turn-") || name.startsWith("excerpt-"))).toBe(false);
  });

  it("keeps the newest 50 turns and one session per deck", () => {
    const store = new ChatSessionStore();
    const session = store.open("d", null);
    for (let index = 0; index < MAX_TURNS + 5; index += 1)
      store.addTurn(session, { user: `u${index}`, assistant: `a${index}` });
    expect(session.turns).toHaveLength(MAX_TURNS);
    expect(session.turns[0]!.user).toBe("u5");
    expect(store.open("d", session.id)).toBe(session);
    expect(store.open("other", session.id)).not.toBe(session);
    const fresh = store.open("d", "unknown");
    expect(fresh.id).not.toBe(session.id);
    expect(store.open("d", session.id)).not.toBe(session); // The old session was replaced.
  });
});

describe("ReplySplitter", () => {
  const split = (chunks: string[]) => {
    const splitter = new ReplySplitter();
    const shown = chunks.map((chunk) => splitter.push(chunk)).join("") + splitter.end();
    return { shown, block: splitter.block };
  };

  it("passes text through when there is no block", () => {
    expect(split(["Slide 4 ", "has two ``` options", "."])).toEqual({
      shown: "Slide 4 has two ``` options.",
      block: null,
    });
  });

  it("separates a fence split across chunks", () => {
    const { shown, block } = split(["I split it.\n``", "`flip", "book-o", 'ps\n[{"a":1}]\n`', "``\nDone."]);
    expect(shown).toBe("I split it.\n\nDone.");
    expect(JSON.parse(block!)).toEqual([{ a: 1 }]);
  });

  it("takes an unclosed block at the end", () => {
    expect(split(["Here:\n```flipbook-ops\n[]"]).block).toBe("\n[]");
  });
});

describe("parseOps", () => {
  it("turns 'split slide 4' into an update and an add", async () => {
    const { deck, context } = await talkContext("Split slide 4");
    const result = await parseOps(
      JSON.stringify([
        {
          kind: "updateSlide",
          slideId: S(4),
          draft: { markdown: "# Give two options\n\nTwo options are enough." },
        },
        {
          kind: "addSlide",
          afterSlideId: S(4),
          draft: { markdown: "# Keep a third aside\n\nIt belongs in an appendix." },
        },
      ]),
      deck,
      context,
    );
    expect(result.dropped).toBe(0);
    expect(result.ops.map((op) => op.kind)).toEqual(["updateSlide", "addSlide"]);
    const update = result.ops[0] as Extract<(typeof result.ops)[number], { kind: "updateSlide" }>;
    expect(update.before!.markdown).toContain("A third belongs in an appendix.");
    expect(update.draft.directives).toEqual(context.drafts.get(S(4))!.directives);
  });

  it("drops hostile ops and keeps the valid ones", async () => {
    const { deck, context } = await talkContext("x");
    const result = await parseOps(
      JSON.stringify([
        { kind: "updateSlide", slideId: "slides/99.slide.md", draft: { markdown: "# Nope" } },
        { kind: "deleteSlide", slideId: "../../etc/passwd" },
        { kind: "moveSlide", slideId: S(2), toIndex: 999 },
        { kind: "writeKitFile", kit: { kind: "theme", name: "x", scope: "library" }, source: "" },
        { kind: "addSlide", afterSlideId: null, draft: { markdown: '# Hi\n\n<script>alert("x")</script>' } },
        { kind: "moveSlide", slideId: S(2), toIndex: 3 },
      ]),
      deck,
      context,
    );
    expect(result.dropped).toBe(4);
    expect(result.ops.map((op) => `${op.id}:${op.kind}`)).toEqual(["op-1:addSlide", "op-2:moveSlide"]);
  });

  it("drops a block that isn't JSON", async () => {
    const { deck, context } = await talkContext("x");
    expect(await parseOps("[{kind: updateSlide", deck, context)).toEqual({ ops: [], dropped: 1 });
  });
});

// ---------------------------------------------------------------- route

async function setup(
  chat: LlmFixture[] | ((request: { messages: { role: string; content: string }[] }) => LlmFixture),
) {
  const root = await workspace();
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({ llm: { baseUrl: "http://127.0.0.1:9/v1", model: "stub-model" } });
  const fake = new FakeProvider({ chat: chat as never });
  const make = () => makeApp(root, [], { settings, llmProvider: () => fake });
  let app = await make();
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const send = async (message: string, sessionId: string | null = null, extra: object = {}) =>
    sseEvents(await post("/api/ai/chat", { deckId: talk, sessionId, message, ...extra }));
  const restart = async () => {
    app = await make();
  };
  return { root, fake, post, send, restart };
}
const text = (events: { event: string; data: { text?: string } }[]) =>
  events
    .filter((event) => event.event === "token")
    .map((event) => event.data.text)
    .join("");

describe("POST /api/ai/chat", () => {
  it("answers with text only, then continues the same session", async () => {
    const { send, fake } = await setup([
      { kind: "text", text: "It asks for a yes on one option." },
      { kind: "text", text: "Slide 5." },
    ]);
    const first = await send("What does the deck ask for?", null, { slideId: S(5) });
    expect(text(first)).toBe("It asks for a yes on one option.");
    expect(first.some((event) => event.event === "proposal")).toBe(false);
    const { sessionId } = first.at(-1)!.data;
    expect(first.at(-1)!.event).toBe("done");
    expect(fake.requests[0]!.messages[0]!.content).toContain("open in the editor");

    const second = await send("Where is that?", sessionId);
    expect(second.at(-1)!.data.sessionId).toBe(sessionId);
    const history = fake.requests[1]!.messages.map((message) => `${message.role}:${message.content}`);
    expect(history.slice(1)).toEqual([
      "user:What does the deck ask for?",
      "assistant:It asks for a yes on one option.",
      "user:Where is that?",
    ]);
  });

  it("streams text and turns the ops block into a proposal that applies", async () => {
    const reply = `I split slide 4.${ops([
      {
        kind: "updateSlide",
        slideId: S(4),
        draft: { markdown: "# Give two options\n\nTwo options are enough." },
      },
      {
        kind: "addSlide",
        afterSlideId: S(4),
        draft: { markdown: "# A third option\n\nPut it in an appendix." },
      },
    ])}`;
    const { send, post, root } = await setup([{ kind: "text", text: reply }]);
    const events = await send("Split slide 4 into two");
    expect(text(events)).toBe("I split slide 4.\n\n");
    const proposal = events.find((event) => event.event === "proposal")!.data;
    expect(proposal.ops.map((op: { kind: string }) => op.kind)).toEqual(["updateSlide", "addSlide"]);
    const applied = await (
      await post(`/api/proposals/${proposal.id}/apply`, { opIds: ["op-1", "op-2"] })
    ).json();
    expect(applied.rejected).toEqual([]);
    const manifest = await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8");
    expect(manifest.match(/slide\.md/g)).toHaveLength(6);
  });

  it("keeps the text and sends a notice when the block is invalid", async () => {
    const { send } = await setup([{ kind: "text", text: "Here you go.\n```flipbook-ops\n[{oops}]\n```" }]);
    const events = await send("Change slide 2");
    expect(text(events)).toBe("Here you go.\n");
    expect(events.find((event) => event.event === "notice")?.data.message).toBe(
      "Some suggestions couldn't become edits",
    );
    expect(events.some((event) => event.event === "proposal")).toBe(false);
    expect(events.at(-1)!.event).toBe("done");
  });

  it("keeps a <script> draft as data; the preview sanitizes it", async () => {
    const reply = `Added.${ops([{ kind: "addSlide", afterSlideId: null, draft: { markdown: '# Hi\n\n<script>alert("x")</script>' } }])}`;
    const { send, post } = await setup([{ kind: "text", text: reply }]);
    const proposal = (await send("Add a slide")).find((event) => event.event === "proposal")!.data;
    const draft = proposal.ops[0].draft;
    const preview = await (await post(`/api/decks/${talk}/preview`, { slideId: S(1), draft })).json();
    expect(preview.html).not.toContain('<script>alert("x")</script>');
  });

  it("groups 12 valid ops into one proposal", async () => {
    const list = Array.from({ length: 12 }, (_, index) => ({
      kind: "addSlide",
      afterSlideId: S(2),
      draft: { markdown: `# Extra ${index}` },
    }));
    const { send } = await setup([{ kind: "text", text: `Twelve.${ops(list)}` }]);
    const proposal = (await send("Add twelve")).find((event) => event.event === "proposal")!.data;
    expect(proposal.ops).toHaveLength(12);
  });

  it("refuses a second stream on the same deck with JOB_RUNNING", async () => {
    const { post, send } = await setup([{ kind: "slowTokens", ms: 40, text: "one two three four five" }]);
    const first = post("/api/ai/chat", { deckId: talk, sessionId: null, message: "Hi" });
    const response = await first;
    const second = await post("/api/ai/chat", { deckId: talk, sessionId: null, message: "Again" });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toMatchObject({
      code: "JOB_RUNNING",
      message: expect.stringContaining("current reply"),
    });
    await sseEvents(response);
    // Once the reply ends, the deck is free again.
    expect((await send("Now?")).at(-1)!.event).toBe("done");
  });

  it("keeps the session across a deck reload and forgets it on restart", async () => {
    const { send, fake, root, restart } = await setup([{ kind: "text", text: "ok" }]);
    const { sessionId } = (await send("First")).at(-1)!.data;
    await fs.appendFile(path.join(root, "talk", S(2)), "\nMore text.\n");
    expect((await send("Second", sessionId)).at(-1)!.data.sessionId).toBe(sessionId);
    expect(fake.requests[1]!.messages).toHaveLength(4);
    await restart();
    const after = (await send("Third", sessionId)).at(-1)!.data.sessionId;
    expect(after).not.toBe(sessionId);
    expect(fake.requests[2]!.messages).toHaveLength(2);
  });

  it("answers 404 for an unknown deck before streaming", async () => {
    const { post } = await setup([{ kind: "text", text: "ok" }]);
    const response = await post("/api/ai/chat", {
      deckId: encodeDeckId("nope"),
      sessionId: null,
      message: "Hi",
    });
    expect(response.status).toBe(404);
  });
});
