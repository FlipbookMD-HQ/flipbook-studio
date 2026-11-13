import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readSlide, type Presentation, type SlideDraft, type Violation } from "@flipbook-md/core";
import {
  SlideDraftSchema,
  SlideIdSchema,
  type ChatRequest,
  type LlmSettings,
  type Proposal,
  type ProposalOp,
} from "../../shared/api.js";
import { deckHashes, findDeck, loadDeck, slideIdAt } from "../decks.js";
import { StudioError } from "../errors.js";
import type { LlmProvider } from "../llm/provider.js";
import type { DeckEntry } from "../workspace.js";
import { contextTokens, fit } from "./budget.js";
import { blueprintOutline } from "./prompts/generate-deck.js";
import { OPS_FENCE, chatMessages, type ChatPart } from "./prompts/chat.js";
import type { ProposalStore } from "./proposals.js";
import type { SseContext } from "./sse.js";
import { aiDebug } from "./structured.js";

export const MAX_TURNS = 50;
export const EXCERPT_CHARS = 300;
const MAX_OPS = 200;

export interface ChatTurn {
  user: string;
  assistant: string;
}
export interface ChatSession {
  id: string;
  deckId: string;
  turns: ChatTurn[];
}

/** Chat history in memory only (lost on restart): one session per deck, the newest 50 turns. */
export class ChatSessionStore {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly running = new Set<string>();

  /** The deck's session with that ID, or a new one (an unknown ID starts over). */
  open(deckId: string, sessionId: string | null): ChatSession {
    const found = sessionId ? this.sessions.get(sessionId) : undefined;
    if (found && found.deckId === deckId) return found;
    for (const [id, session] of this.sessions) if (session.deckId === deckId) this.sessions.delete(id);
    const session: ChatSession = { id: randomUUID(), deckId, turns: [] };
    this.sessions.set(session.id, session);
    return session;
  }

  addTurn(session: ChatSession, turn: ChatTurn) {
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
  }

  /** Claims the deck's one chat stream, or 409 JOB_RUNNING. */
  begin(deckId: string) {
    if (this.running.has(deckId))
      throw new StudioError(409, "JOB_RUNNING", "Wait for the current reply before sending another message.");
    this.running.add(deckId);
  }

  end(deckId: string) {
    this.running.delete(deckId);
  }
}

export interface DeckContext {
  /** Every slide ID in order: the only IDs ops may name. */
  ids: string[];
  drafts: Map<string, SlideDraft>;
  parts: ChatPart[];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const excerpt = (markdown: string) => {
  const flat = oneLine(markdown);
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
};

/** 1-based slide numbers the message names ("slide 4", "slide #2"). */
export function mentionedSlides(message: string): number[] {
  return [...message.matchAll(/\bslide\s*#?\s*(\d{1,4})\b/gi)].map((match) => Number(match[1]));
}

/**
 * The deck as prompt parts: the slide list (ID, index, type, template, title; never dropped),
 * the kit, blueprint and current violations, the full text of the open slide and any slide the
 * message names, and a 300-character excerpt of every slide. Excerpts go before full texts
 * when the context budget is short; history turns go before both.
 */
export async function buildDeckContext(
  deck: DeckEntry,
  loaded: { presentation: Presentation; violations: Violation[] },
  options: { openSlideId?: string | null; message: string },
): Promise<DeckContext> {
  const { presentation, violations } = loaded;
  const ids = presentation.slides.map((_, index) => slideIdAt(deck, presentation, index));
  const drafts = new Map<string, SlideDraft>();
  for (const id of ids) drafts.set(id, (await readSlide(deck.absolute, id)).draft as SlideDraft);

  const list = presentation.slides.map((slide, index) => {
    const fields = [
      `id ${JSON.stringify(ids[index])}`,
      `type ${slide.type ?? "none"}`,
      `template ${slide.template}`,
      `title ${JSON.stringify(slide.title ?? "")}`,
    ];
    return `${index + 1}. ${fields.join(" · ")}`;
  });
  const parts: ChatPart[] = [
    {
      name: "slides",
      priority: 0,
      text: `Deck: ${JSON.stringify(presentation.title)}${presentation.group ? ` · media kit ${presentation.group}` : ""}\nSlides (number, ID, type, template, title):\n${list.join("\n")}`,
    },
  ];
  parts.push({
    name: "blueprint",
    priority: 1,
    text: presentation.blueprint
      ? blueprintOutline(presentation.blueprint)
      : "This deck has no blueprint: no slide rules apply.",
  });
  if (presentation.blueprint) {
    const byId = (source: string) => {
      const index = presentation.slides.findIndex((slide) => slide.source === source);
      return index >= 0 ? `slide ${index + 1} (${ids[index]})` : source;
    };
    parts.push({
      name: "violations",
      priority: 1,
      text: violations.length
        ? `Current rule problems:\n${violations.map((item) => `- ${item.source ? byId(item.source) : "deck"}: ${item.message}`).join("\n")}`
        : "The deck currently matches its blueprint.",
    });
  }
  const full = new Set<number>();
  const open = options.openSlideId ? ids.indexOf(options.openSlideId) : -1;
  if (open >= 0) full.add(open);
  for (const number of mentionedSlides(options.message))
    if (number >= 1 && number <= ids.length) full.add(number - 1);
  for (const index of [...full].sort((a, b) => a - b)) {
    const draft = drafts.get(ids[index]!)!;
    parts.push({
      name: `slide-${index + 1}`,
      priority: 1,
      text: `Slide ${index + 1} (${ids[index]})${index === open ? ", open in the editor" : ""}, full text:\n<slide_markdown>\n${draft.markdown}\n</slide_markdown>${draft.notes.trim() ? `\n<speaker_notes>\n${draft.notes}\n</speaker_notes>` : ""}`,
    });
  }
  ids.forEach((id, index) => {
    if (full.has(index)) return;
    parts.push({
      name: `excerpt-${index + 1}`,
      priority: 2,
      text: `Slide ${index + 1} (${id}) excerpt: ${excerpt(drafts.get(id)!.markdown)}`,
    });
  });
  return { ids, drafts, parts };
}

/** History as parts: the oldest turn gets the highest number, so it is dropped first. */
export function historyParts(turns: ChatTurn[]): ChatPart[] {
  return turns.map((turn, index) => ({
    name: `turn-${index + 1}`,
    priority: 3 + (turns.length - index),
    text: `${turn.user}\n${turn.assistant}`,
    turn,
  }));
}

/**
 * Splits a streamed reply into text (safe to show as it arrives) and one `flipbook-ops` block.
 * Text that might be the start of the fence is held back until the next chunk decides.
 */
export class ReplySplitter {
  private state: "text" | "block" | "after" = "text";
  private pending = "";
  private blockText = "";
  block: string | null = null;
  text = "";

  push(chunk: string): string {
    let out = "";
    if (this.state === "after") out = chunk;
    else if (this.state === "block") out = this.closeBlock(chunk);
    else {
      this.pending += chunk;
      const at = this.pending.indexOf(OPS_FENCE);
      if (at >= 0) {
        out = this.pending.slice(0, at);
        const rest = this.pending.slice(at + OPS_FENCE.length);
        this.pending = "";
        this.state = "block";
        out += this.closeBlock(rest);
      } else {
        let keep = Math.min(this.pending.length, OPS_FENCE.length - 1);
        while (keep > 0 && !OPS_FENCE.startsWith(this.pending.slice(-keep))) keep -= 1;
        out = this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
      }
    }
    this.text += out;
    return out;
  }

  private closeBlock(chunk: string): string {
    this.blockText += chunk;
    const close = this.blockText.indexOf("```");
    if (close < 0) return "";
    this.block = this.blockText.slice(0, close);
    this.state = "after";
    return this.blockText.slice(close + 3);
  }

  /** The text still held back; an unclosed block counts as the block. */
  end(): string {
    if (this.state === "block") {
      this.block = this.blockText;
      this.state = "after";
    }
    const rest = this.state === "text" ? this.pending : "";
    this.pending = "";
    this.text += rest;
    return rest;
  }
}

const PartialDraft = SlideDraftSchema.partial().extend({ markdown: z.string().max(200_000) });
const RawOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("updateSlide"), slideId: SlideIdSchema, draft: PartialDraft }),
  z.object({
    kind: z.literal("addSlide"),
    afterSlideId: SlideIdSchema.nullable().optional(),
    draft: PartialDraft,
  }),
  z.object({ kind: z.literal("deleteSlide"), slideId: SlideIdSchema }),
  z.object({ kind: z.literal("moveSlide"), slideId: SlideIdSchema, toIndex: z.number().int() }),
]);

const EMPTY_DRAFT: SlideDraft = {
  markdown: "",
  template: null,
  type: null,
  notes: "",
  title: null,
  directives: {},
};

/**
 * Turns an ops block into checked proposal ops: known slide IDs only, toIndex in range, and
 * drafts that load. Anything else is dropped (counted, so the caller can say so).
 */
export async function parseOps(
  block: string,
  deck: DeckEntry,
  context: DeckContext,
): Promise<{ ops: ProposalOp[]; dropped: number }> {
  let raw: unknown;
  try {
    raw = JSON.parse(block.trim());
  } catch {
    return { ops: [], dropped: 1 };
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { ops?: unknown })?.ops)
      ? (raw as { ops: unknown[] }).ops
      : null;
  if (!list) return { ops: [], dropped: 1 };
  const known = new Set(context.ids);
  const ops: ProposalOp[] = [];
  let dropped = Math.max(0, list.length - MAX_OPS);
  for (const item of list.slice(0, MAX_OPS)) {
    const parsed = RawOp.safeParse(item);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    const op = parsed.data;
    const id = `op-${ops.length + 1}`;
    try {
      switch (op.kind) {
        case "updateSlide": {
          if (!known.has(op.slideId)) throw new Error("unknown slide");
          const before = context.drafts.get(op.slideId)!;
          const draft = SlideDraftSchema.parse({ ...before, ...op.draft });
          const checked = await loadDeck(deck, { slideId: op.slideId, draft });
          const source = checked.presentation.slides[context.ids.indexOf(op.slideId)]?.source;
          ops.push({
            id,
            kind: "updateSlide",
            slideId: op.slideId,
            draft,
            before,
            violations: checked.violations.filter((violation) => violation.source === source),
          });
          break;
        }
        case "addSlide": {
          const after = op.afterSlideId ?? null;
          if (after !== null && !known.has(after)) throw new Error("unknown slide");
          const draft = SlideDraftSchema.parse({ ...EMPTY_DRAFT, ...op.draft });
          // The draft must load like any slide (checked in place of the first slide, in memory).
          await loadDeck(deck, { slideId: context.ids[0]!, draft });
          ops.push({ id, kind: "addSlide", afterSlideId: after, draft });
          break;
        }
        case "deleteSlide":
          if (!known.has(op.slideId)) throw new Error("unknown slide");
          ops.push({ id, kind: "deleteSlide", slideId: op.slideId });
          break;
        case "moveSlide":
          if (!known.has(op.slideId) || op.toIndex < 0 || op.toIndex >= context.ids.length)
            throw new Error("out of range");
          ops.push({ id, kind: "moveSlide", slideId: op.slideId, toIndex: op.toIndex });
          break;
      }
    } catch {
      dropped += 1;
    }
  }
  return { ops, dropped };
}

/** POST /api/ai/chat: streams the reply text, then an optional proposal, then done {sessionId}. */
export async function runChat(
  context: SseContext,
  root: string,
  request: ChatRequest,
  session: ChatSession,
  deps: {
    provider: LlmProvider;
    llm: LlmSettings & { model: string };
    sessions: ChatSessionStore;
    store: ProposalStore;
    log?: (line: string) => void;
  },
) {
  const deck = await findDeck(root, request.deckId);
  const loaded = await loadDeck(deck);
  const hashes = await deckHashes(deck);
  const deckContext = await buildDeckContext(deck, loaded, {
    openSlideId: request.slideId ?? null,
    message: request.message,
  });
  const tokens = await contextTokens(deps.provider, deps.llm.baseUrl, deps.llm.model, context.signal);
  const message: ChatPart = { name: "message", priority: 0, text: request.message };
  const fitted = fit([...deckContext.parts, ...historyParts(session.turns), message], tokens);
  if (fitted.trimmed) context.send("notice", { message: "Using a shortened deck context" });
  const messages = chatMessages(
    fitted.parts.filter((part) => part !== message),
    request.message,
  );

  const log = deps.log ?? (() => {});
  if (aiDebug()) log(`ai prompt: ${JSON.stringify(messages)}`);
  const splitter = new ReplySplitter();
  let raw = "";
  for await (const event of deps.provider.chat({
    model: deps.llm.model,
    messages,
    temperature: deps.llm.temperature,
    signal: context.signal,
  })) {
    if (event.type !== "delta") continue;
    raw += event.text;
    const text = splitter.push(event.text);
    if (text) context.send("token", { text });
  }
  const rest = splitter.end();
  if (rest) context.send("token", { text: rest });
  if (aiDebug()) log(`ai reply: ${raw}`);

  if (splitter.block != null) {
    const { ops, dropped } = await parseOps(splitter.block, deck, deckContext);
    if (dropped) context.send("notice", { message: "Some suggestions couldn't become edits" });
    if (ops.length) {
      const proposal: Proposal = deps.store.add({
        deckId: request.deckId,
        summary: oneLine(splitter.text).slice(0, 120) || `${ops.length} edit${ops.length === 1 ? "" : "s"}`,
        ops,
        baseHashes: hashes,
      });
      context.send("proposal", proposal);
    }
  }
  deps.sessions.addTurn(session, { user: request.message, assistant: raw });
  return { sessionId: session.id };
}
