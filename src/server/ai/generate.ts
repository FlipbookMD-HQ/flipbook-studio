import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  TEMPLATES,
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
  writeDeckAsset,
  type Blueprint,
  type SlideDraft,
  type Violation,
} from "@flipbook-md/core";
import { z } from "zod";
import { GENERATE_TEXT_LIMIT, type GenerateDeckRequest, type LlmSettings } from "../../shared/api.js";
import { slideIdAt } from "../decks.js";
import { StudioError } from "../errors.js";
import { LlmError, type ChatMessage, type LlmProvider } from "../llm/provider.js";
import type { LoadedSource, SourceStore } from "../sources.js";
import { TMP_DIR, type DeckEntry } from "../workspace.js";
import {
  assertFree,
  entryName,
  ignoreGenerationTemp,
  publish,
  removeRun,
  type GenerationRuns,
} from "../temp-decks.js";

// Kept here too: the launcher and tests import them from generate.
export { GenerationRuns, ignoreGenerationTemp, resetGenerationTemp } from "../temp-decks.js";
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

export interface PreparedGeneration {
  blueprint: Blueprint | null;
  templates: string[];
  /** An uploaded file (US-18), read before streaming so an expired one answers with plain JSON. */
  source?: LoadedSource;
}

/** The checks that answer before streaming: size, name, kit. */
export async function prepareGenerate(
  root: string,
  request: GenerateDeckRequest,
  sources?: SourceStore,
): Promise<PreparedGeneration> {
  let source: LoadedSource | undefined;
  if ("sourceId" in request.source) {
    if (request.kind !== "folder")
      throw new StudioError(422, "VALIDATION_FAILED", "A deck from a file is always a folder deck.", {
        details: { fields: [{ path: "kind", message: "Use folder." }] },
      });
    if (!sources)
      throw new StudioError(404, "SOURCE_EXPIRED", "That file is no longer available. Pick it again.");
    source = await sources.get(root, request.source.sourceId);
  }
  if ("text" in request.source && request.source.text.length > GENERATE_TEXT_LIMIT) {
    throw new StudioError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The source text is over 200,000 characters. Trim it and try again.",
    );
  }
  await assertFree(root, entryName(request.name, request.kind));
  if (!request.group) return { blueprint: null, templates: Object.keys(TEMPLATES), source };
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
      source,
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

// US-18: with an uploaded file, slides may use only its images. Keyed by the temp deck.
const allowedImages = new WeakMap<DeckEntry, { paths: Set<string>; removed: number }>();
const LOCAL_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Removes local image references that aren't the file's own images. */
function onlyAllowedImages(deck: DeckEntry, draft: SlideDraft): SlideDraft {
  const allowed = allowedImages.get(deck);
  if (!allowed) return draft;
  const markdown = draft.markdown.replace(LOCAL_IMAGE, (match, href: string) => {
    if (/^(?:https?:|data:)/i.test(href) || allowed.paths.has(href)) return match;
    allowed.removed += 1;
    return "";
  });
  return markdown === draft.markdown
    ? draft
    : { ...draft, markdown: markdown.replace(/\n{3,}/g, "\n\n").trim() };
}

/** Appends a slide; a template core doesn't know is dropped rather than losing the slide. */
async function append(deck: DeckEntry, given: SlideDraft): Promise<SlideDraft> {
  const draft = onlyAllowedImages(deck, given);
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

async function update(deck: DeckEntry, id: string, given: SlideDraft) {
  const draft = onlyAllowedImages(deck, given);
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
  /** Consumes an uploaded file once its deck is published (US-18). */
  sources?: SourceStore;
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

    // An uploaded file: its images go into the deck first, under the upload rules (D19).
    let source: { text: string } | { topic: string } =
      "sourceId" in request.source ? { text: "" } : request.source;
    const images: string[] = [];
    if (prepared.source) {
      let text = prepared.source.markdown;
      for (const image of prepared.source.images) {
        const stored = await writeDeckAsset(deck.absolute, image.fileName, image.bytes);
        text = text.split(`](${image.fileName})`).join(`](${stored.path})`);
        images.push(stored.path);
      }
      source = { text };
      allowedImages.set(deck, { paths: new Set(images), removed: 0 });
    }

    // 1. Stream the slides.
    const tokens = await contextTokens(deps.provider, deps.llm.baseUrl, deps.llm.model, signal);
    const budget = Math.floor(tokens * 0.8 * 4 * 0.6);
    const { messages, trimmed } = generateMessages(
      {
        title: request.title,
        blueprint: prepared.blueprint,
        templates: prepared.templates,
        source,
        images,
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

    const removedImages = allowedImages.get(deck)?.removed ?? 0;
    if (removedImages)
      context.send("notice", {
        message: `Removed ${removedImages} image reference(s) that weren't in the file`,
      });

    // 3. Publish.
    if (signal.aborted) throw cancelled();
    let deckId: string;
    try {
      deckId = await publish(root, deck, request.name, runId);
    } catch (error) {
      if (error instanceof StudioError && error.code === "DECK_EXISTS") {
        keep = true;
        deps.runs.keep(runId, { dir, deck });
        if ("sourceId" in request.source) await deps.sources?.consume(root, request.source.sourceId);
      }
      throw error;
    }
    if ("sourceId" in request.source) await deps.sources?.consume(root, request.source.sourceId);
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
