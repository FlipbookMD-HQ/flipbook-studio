import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  TEMPLATES,
  atomicWrite,
  createDeck,
  hashBytes,
  insertSlide,
  loadGroup,
  loadPresentation,
  normalizeBlueprint,
  readSlide,
  removeSlide,
  reorderSlides,
  updateSlide,
  type Blueprint,
  type SlideDraft,
  type Violation,
} from "@flipbook-md/core";
import { z } from "zod";
import { GENERATE_TEXT_LIMIT, type GenerateDeckRequest, type LlmSettings } from "../../shared/api.js";
import { slideIdAt } from "../decks.js";
import { StudioError } from "../errors.js";
import { LlmError, type ChatMessage, type LlmProvider } from "../llm/provider.js";
import { encodeDeckId } from "../paths.js";
import { TMP_DIR, type DeckEntry } from "../workspace.js";
import { contextTokens } from "./budget.js";
import { JsonLinesParser, SlideLineSchema, type SlideLine } from "./jsonl.js";
import {
  GENERATE_SYSTEM,
  blueprintOutline,
  describeRules,
  generateMessages,
} from "./prompts/generate-deck.js";
import type { SseContext } from "./sse.js";
import { aiDebug, structuredCall } from "./structured.js";

const MAX_SLIDES = 100;
const SEQUENCE_CODES = new Set(["ORDER", "MISSING_TYPE"]);

/** Empties the generation temp folder (D17): Studio calls it at startup, so a crash leaves nothing behind. */
export async function resetGenerationTemp(root: string): Promise<void> {
  await fs.rm(path.join(root, TMP_DIR), { recursive: true, force: true });
}

/** Adds the temp folder to the workspace's .gitignore when the workspace is a git repo and the line is missing. */
export async function ignoreGenerationTemp(root: string): Promise<void> {
  const isRepo = await fs.stat(path.join(root, ".git")).then(
    () => true,
    () => false,
  );
  if (!isRepo) return;
  const file = path.join(root, ".gitignore");
  const bytes = await fs.readFile(file).catch(() => null);
  const text = bytes?.toString("utf8") ?? "";
  if (text.split(/\r?\n/).some((line) => line.trim().replace(/^\//, "").replace(/\/$/, "") === TMP_DIR))
    return;
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${TMP_DIR}/\n`;
  await atomicWrite(file, next, { baseHash: bytes ? hashBytes(bytes) : null, roots: [root] });
}

/** Refuses a name taken in `dir`, including one differing only in case. */
async function assertFree(dir: string, entry: string, runId?: string): Promise<void> {
  const entries = await fs.readdir(dir);
  if (entries.some((name) => name.toLowerCase() === entry.toLowerCase())) {
    throw new StudioError(409, "DECK_EXISTS", `A deck named ${entry} already exists. Pick another name.`, {
      path: entry,
      ...(runId ? { details: { runId } } : {}),
    });
  }
}

/** Removes a run folder, and the temp folder too once it's empty, so a cancel leaves the workspace as it was. */
async function removeRun(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rmdir(path.dirname(dir)).catch(() => {});
}

const entryName = (name: string, kind: "folder" | "single") =>
  kind === "folder" ? name : `${name}.slide.md`;

interface Run {
  dir: string;
  deck: DeckEntry;
}

/** Generated decks waiting for a Save as after DECK_EXISTS (memory only; the folder goes at the next start). */
export class GenerationRuns {
  private readonly runs = new Map<string, Run>();

  keep(id: string, run: Run) {
    this.runs.set(id, run);
  }

  /** POST /api/ai/generate-deck/:runId/save-as: publishes the kept deck under another name. */
  async saveAs(root: string, runId: string, name: string): Promise<{ deckId: string }> {
    const run = this.runs.get(runId);
    if (!run)
      throw new StudioError(
        404,
        "PROPOSAL_NOT_FOUND",
        "That generated deck no longer exists. Generate it again.",
      );
    const deckId = await publish(root, run.deck, name);
    this.runs.delete(runId);
    await removeRun(run.dir);
    return { deckId };
  }
}

/**
 * Moves a finished temp deck into the workspace without replacing anything: a folder is renamed,
 * a single file is hard-linked then unlinked (link fails if the name exists).
 */
async function publish(root: string, deck: DeckEntry, name: string, runId?: string): Promise<string> {
  const entry = entryName(name, deck.kind);
  await assertFree(root, entry, runId);
  const target = path.join(root, entry);
  try {
    if (deck.kind === "folder") await fs.rename(deck.absolute, target);
    else {
      await fs.link(deck.absolute, target);
      await fs.unlink(deck.absolute);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY")
      throw new StudioError(409, "DECK_EXISTS", `A deck named ${entry} already exists. Pick another name.`, {
        path: entry,
        ...(runId ? { details: { runId } } : {}),
      });
    throw error;
  }
  deck.absolute = target;
  deck.relative = entry;
  return encodeDeckId(entry);
}

export interface PreparedGeneration {
  blueprint: Blueprint | null;
  templates: string[];
}

/** The checks that answer before streaming: size, name, kit. */
export async function prepareGenerate(
  root: string,
  request: GenerateDeckRequest,
): Promise<PreparedGeneration> {
  if ("text" in request.source && request.source.text.length > GENERATE_TEXT_LIMIT) {
    throw new StudioError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The source text is over 200,000 characters. Trim it and try again.",
    );
  }
  await assertFree(root, entryName(request.name, request.kind));
  if (!request.group) return { blueprint: null, templates: Object.keys(TEMPLATES) };
  let group;
  try {
    group = await loadGroup(request.group);
  } catch (error) {
    if (/^Unknown template group|is not a valid name/.test((error as Error).message))
      throw new StudioError(404, "KIT_NOT_FOUND", `No media kit named ${request.group}.`);
    throw new StudioError(422, "KIT_INVALID", (error as Error).message);
  }
  try {
    return {
      blueprint: normalizeBlueprint(group.blueprint, group.templates),
      templates: [...Object.keys(group.templates), ...Object.keys(TEMPLATES)],
    };
  } catch (error) {
    throw new StudioError(422, "KIT_INVALID", (error as Error).message);
  }
}

// ---------- the temp deck ----------

async function structureHash(deck: DeckEntry): Promise<string> {
  return hashBytes(
    await fs.readFile(deck.kind === "folder" ? path.join(deck.absolute, "presentation.yml") : deck.absolute),
  );
}

async function evaluate(deck: DeckEntry) {
  const { presentation, violations } = await loadPresentation(deck.absolute, { blueprint: "evaluate" });
  const ids = presentation.slides.map((_, index) => slideIdAt(deck, presentation, index));
  return { presentation, violations: violations as Violation[], ids };
}

function toDraft(line: SlideLine, deck: DeckEntry): SlideDraft {
  return {
    markdown: line.markdown.trim(),
    template: line.template?.trim() || null,
    type: line.type?.trim() || null,
    notes: line.notes?.trim() ?? "",
    title: deck.kind === "folder" ? line.title?.trim() || null : null,
    directives: {},
  };
}

/** Appends a slide; a template core doesn't know is dropped rather than losing the slide. */
async function append(deck: DeckEntry, draft: SlideDraft): Promise<SlideDraft> {
  const { ids } = await evaluate(deck);
  try {
    await insertSlide(deck.absolute, ids.at(-1) ?? null, draft, await structureHash(deck));
    return draft;
  } catch (error) {
    if (!draft.template) throw error;
    const plain = { ...draft, template: null };
    await insertSlide(deck.absolute, ids.at(-1) ?? null, plain, await structureHash(deck));
    return plain;
  }
}

/** Removes the slides at `positions` (indexes into the current order), last first so indexes hold. */
async function removeAt(deck: DeckEntry, positions: number[]) {
  for (const position of [...positions].sort((a, b) => b - a)) {
    const { ids } = await evaluate(deck);
    await removeSlide(deck.absolute, ids[position]!, await structureHash(deck));
  }
}

async function update(deck: DeckEntry, id: string, draft: SlideDraft) {
  const read = await readSlide(deck.absolute, id);
  try {
    await updateSlide(deck.absolute, id, draft, read.hash);
  } catch (error) {
    if (!draft.template) throw error;
    await updateSlide(deck.absolute, id, { ...draft, template: null }, read.hash);
  }
}

// ---------- the run ----------

export interface GenerateDeps {
  provider: LlmProvider;
  llm: LlmSettings & { model: string };
  runs: GenerationRuns;
  log?: (line: string) => void;
}

const cancelled = () => new LlmError("cancelled", "Cancelled.");

async function chatLines(
  deps: GenerateDeps,
  messages: ChatMessage[],
  signal: AbortSignal,
  onLine: (line: unknown) => Promise<void>,
  schema: z.ZodType<unknown> = SlideLineSchema,
) {
  const parser = new JsonLinesParser(schema);
  if (aiDebug()) deps.log?.(`ai prompt: ${JSON.stringify(messages)}`);
  let raw = "";
  for await (const event of deps.provider.chat({
    model: deps.llm.model,
    messages,
    temperature: deps.llm.temperature,
    signal,
  })) {
    if (event.type !== "delta") continue;
    raw += event.text;
    for (const line of parser.push(event.text)) await onLine(line);
  }
  for (const line of parser.end()) await onLine(line);
  if (aiDebug()) deps.log?.(`ai reply: ${raw}`);
}

/**
 * POST /api/ai/generate-deck: writes the deck into `.flipbook-studio-tmp/<runId>/` as slides
 * stream in, repairs blueprint violations, then renames it into the workspace (D11, D17). Any
 * failure or a disconnect removes the run folder; DECK_EXISTS at publish keeps it for Save as.
 */
export async function runGenerate(
  context: SseContext,
  root: string,
  request: GenerateDeckRequest,
  prepared: PreparedGeneration,
  deps: GenerateDeps,
) {
  const { signal } = context;
  const runId = randomUUID();
  const dir = path.join(root, TMP_DIR, runId);
  let keep = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await ignoreGenerationTemp(root).catch((error) =>
      deps.log?.(`Could not update .gitignore: ${(error as Error).message}`),
    );
    const created = await createDeck(dir, {
      name: request.name,
      title: request.title,
      kind: request.kind,
      group: request.group,
    });
    const deck: DeckEntry = {
      relative: path.basename(created.path),
      absolute: created.path,
      kind: request.kind,
    };
    const placeholders = (await evaluate(deck)).ids.length;

    // 1. Stream the slides.
    const tokens = await contextTokens(deps.provider, deps.llm.baseUrl, deps.llm.model, signal);
    const budget = Math.floor(tokens * 0.8 * 4 * 0.6);
    const { messages, trimmed } = generateMessages(
      {
        title: request.title,
        blueprint: prepared.blueprint,
        templates: prepared.templates,
        source: request.source,
        language: request.language,
      },
      budget - 3000,
    );
    if (trimmed) context.send("notice", { message: "Using a shortened source text" });
    let index = 0;
    await chatLines(deps, messages, signal, async (line) => {
      if (signal.aborted) throw cancelled();
      if (index >= MAX_SLIDES) return;
      const draft = await append(deck, toDraft(line as SlideLine, deck));
      context.send("slide", { index: index++, draft });
    });
    if (signal.aborted) throw cancelled();
    await removeAt(deck, [...Array(placeholders).keys()]);

    // 2. Repair, up to maxRepairRounds; stop as soon as the deck passes.
    let state = await evaluate(deck);
    for (
      let round = 1;
      round <= deps.llm.maxRepairRounds && prepared.blueprint && state.violations.length;
      round += 1
    ) {
      context.send("repair", { round, violations: state.violations });
      if (state.violations.some((violation) => SEQUENCE_CODES.has(violation.code)))
        await sequenceRepair(deck, state, prepared.blueprint, request, deps, signal);
      else await slideRepairs(deck, state, prepared.blueprint, deps, signal);
      if (signal.aborted) throw cancelled();
      state = await evaluate(deck);
    }

    // 3. Publish.
    if (signal.aborted) throw cancelled();
    let deckId: string;
    try {
      deckId = await publish(root, deck, request.name, runId);
    } catch (error) {
      if (error instanceof StudioError && error.code === "DECK_EXISTS") {
        keep = true;
        deps.runs.keep(runId, { dir, deck });
      }
      throw error;
    }
    return { deckId, violations: state.violations };
  } finally {
    if (!keep) await removeRun(dir);
  }
}

type Evaluated = Awaited<ReturnType<typeof evaluate>>;

/** One targeted prompt per failing slide; slides that pass are never sent back. */
async function slideRepairs(
  deck: DeckEntry,
  state: Evaluated,
  blueprint: Blueprint,
  deps: GenerateDeps,
  signal: AbortSignal,
) {
  const bySource = new Map<string, string[]>();
  for (const violation of state.violations) {
    bySource.set(violation.source, [...(bySource.get(violation.source) ?? []), violation.message]);
  }
  for (const [source, problems] of bySource) {
    const index = state.presentation.slides.findIndex((slide) => slide.source === source);
    if (index < 0) continue;
    const id = state.ids[index]!;
    const current = (await readSlide(deck.absolute, id)).draft;
    const type = current.type ?? state.presentation.slides[index]!.type ?? null;
    const rules = type ? describeRules(blueprint.types[type]) : [];
    const output = await structuredCall({
      provider: deps.provider,
      model: deps.llm.model,
      temperature: deps.llm.temperature,
      signal,
      log: deps.log,
      schema: SlideLineSchema,
      messages: [
        {
          role: "system",
          content: GENERATE_SYSTEM.replace(
            /^Answer with JSON Lines.*$/m,
            "Answer with one JSON object for the slide, and nothing else.",
          ),
        },
        {
          role: "user",
          content: [
            `This slide${type ? ` (type "${type}")` : ""} breaks the deck's rules:`,
            ...problems.map((problem) => `- ${problem}`),
            rules.length ? `The rules for this type: ${rules.join("; ")}.` : "",
            "Rewrite it so it follows them. Keep its facts and language.",
            `<slide_markdown>\n${current.markdown}\n</slide_markdown>`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    await update(deck, id, {
      ...current,
      markdown: output.markdown.trim(),
      notes: output.notes?.trim() ?? current.notes,
    });
  }
}

const SequenceLineSchema = z.union([
  z.object({ keep: z.number().int().nonnegative() }).strict(),
  SlideLineSchema,
]);

/**
 * One prompt for ORDER / MISSING_TYPE: the model returns the whole sequence as JSON Lines where
 * an existing slide is `{"keep": <index>}`; only new slides are written from scratch.
 */
async function sequenceRepair(
  deck: DeckEntry,
  state: Evaluated,
  blueprint: Blueprint,
  request: GenerateDeckRequest,
  deps: GenerateDeps,
  signal: AbortSignal,
) {
  const listing = state.presentation.slides
    .map((slide, index) => `${index}: type ${slide.type ? `"${slide.type}"` : "none"} — ${slide.title}`)
    .join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: GENERATE_SYSTEM },
    {
      role: "user",
      content: [
        `Deck title: ${request.title}`,
        blueprintOutline(blueprint),
        `The deck's slides now:\n${listing}`,
        `Problems:\n${state.violations.map((violation) => `- ${violation.message}`).join("\n")}`,
        'Fix the order and the missing steps. Answer with the whole deck as JSON Lines, in the right order: for an existing slide that can stay as it is, write only {"keep": <its number>}; write new slides in full. Leave out slides that don\'t belong.',
      ].join("\n\n"),
    },
  ];
  const plan: ({ keep: number } | SlideDraft)[] = [];
  await chatLines(
    deps,
    messages,
    signal,
    async (line) => {
      if (signal.aborted) throw cancelled();
      const item = line as { keep: number } | SlideLine;
      if ("keep" in item) {
        if (
          item.keep < state.ids.length &&
          !plan.some((entry) => "keep" in entry && entry.keep === item.keep)
        )
          plan.push(item);
      } else plan.push(toDraft(item, deck));
    },
    SequenceLineSchema,
  );
  if (!plan.length) return;
  // Append the new slides, then order everything: wanted slides first, the dropped ones last, then remove those.
  const existing = state.ids.length;
  let added = 0;
  const order: number[] = [];
  for (const entry of plan) {
    if ("keep" in entry) order.push(entry.keep);
    else {
      await append(deck, entry);
      order.push(existing + added++);
    }
  }
  const dropped = [...Array(existing).keys()].filter((position) => !order.includes(position));
  const { ids } = await evaluate(deck);
  await reorderSlides(
    deck.absolute,
    [...order, ...dropped].map((position) => ids[position]!),
    await structureHash(deck),
  );
  await removeAt(
    deck,
    dropped.map((_, offset) => order.length + offset),
  );
}
