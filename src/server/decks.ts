import fs from "node:fs/promises";
import path from "node:path";
import {
  FileConflictError,
  LastSlideError,
  hashBytes,
  TEMPLATES,
  ValidationError,
  createDeck,
  discoverPresentation,
  insertSlide,
  readSlide,
  removeSlide,
  reorderSlides,
  renderSlideDocument,
  updateSlide,
  type Presentation,
  type SlideDraft,
} from "@flipbook-md/core";
import type { CreateDeckRequest, DeckDetail, SlideDoc, StructureResponse } from "../shared/api.js";
import { StudioError } from "./errors.js";
import { decodeDeckId, encodeDeckId, resolveInside } from "./paths.js";
import { findDecks, loadError, type DeckEntry } from "./workspace.js";

const WRITE_ERRORS = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EISDIR", "EBUSY"]);

export async function findDeck(root: string, id: string): Promise<DeckEntry> {
  const relative = decodeDeckId(id);
  const deck = (await findDecks(root)).find((entry) => entry.relative === relative);
  if (!deck) throw new StudioError(404, "DECK_NOT_FOUND", "No deck with that ID.");
  return deck;
}

export async function loadDeck(deck: DeckEntry): Promise<Presentation> {
  try {
    return await discoverPresentation(deck.absolute);
  } catch (error) {
    const apiError = loadError(error, deck.relative);
    throw new StudioError(422, "DECK_LOAD_FAILED", apiError.message, {
      path: deck.relative,
      details: apiError.details,
    });
  }
}

/** Folder decks use the manifest path; single-file decks use `#<index>`. */
function slideIdAt(deck: DeckEntry, presentation: Presentation, index: number): string {
  return deck.kind === "folder" ? presentation.slides[index]!.source : `#${index}`;
}

function slideIndex(deck: DeckEntry, presentation: Presentation, slideId: string): number {
  const index =
    deck.kind === "folder"
      ? presentation.slides.findIndex((slide) => slide.source === slideId)
      : /^#\d+$/.test(slideId)
        ? Number(slideId.slice(1))
        : -1;
  if (index < 0 || index >= presentation.slides.length) {
    throw new StudioError(404, "SLIDE_NOT_FOUND", "No slide with that ID in this deck.", { path: slideId });
  }
  return index;
}

const assetBase = (id: string) => `/api/decks/${id}/files/`;

function renderError(error: unknown): never {
  if (error instanceof ValidationError) {
    throw new StudioError(422, "RENDER_FAILED", error.message, {
      details: { field: error.field ?? null, ...(error.fields ? { fields: error.fields } : {}) },
    });
  }
  throw error;
}

async function slideDoc(
  deck: DeckEntry,
  presentation: Presentation,
  id: string,
  index: number,
): Promise<{ doc: SlideDoc; hash: string }> {
  const slideId = slideIdAt(deck, presentation, index);
  const slide = presentation.slides[index]!;
  const read = await readSlide(deck.absolute, slideId);
  const doc: SlideDoc = {
    id: slideId,
    index,
    title: slide.title,
    template: slide.template,
    type: slide.type ?? null,
    html: await renderSlideDocument(presentation, index, { assetBase: assetBase(id) }),
    draft: read.draft,
    file: deck.kind === "folder" ? slideId : path.basename(deck.absolute),
  };
  return { doc, hash: read.hash };
}

/** Every slide's SlideDoc and every file hash (the manifest's too, for folder decks). */
async function deckSlides(
  deck: DeckEntry,
  presentation: Presentation,
  id: string,
): Promise<{ slides: SlideDoc[]; hashes: Record<string, string> }> {
  const docs = await Promise.all(
    presentation.slides.map((_, index) => slideDoc(deck, presentation, id, index)),
  );
  const hashes: Record<string, string> = {};
  if (deck.kind === "folder") {
    const manifest = await fs.readFile(path.join(deck.absolute, "presentation.yml"));
    hashes["presentation.yml"] = hashBytes(manifest);
  }
  for (const { doc, hash } of docs) hashes[doc.file] = hash;
  return { slides: docs.map(({ doc }) => doc), hashes };
}

export async function deckDetail(root: string, id: string): Promise<DeckDetail> {
  const deck = await findDeck(root, id);
  const presentation = await loadDeck(deck);
  const { slides, hashes } = await deckSlides(deck, presentation, id);
  return {
    id,
    path: deck.relative,
    kind: deck.kind,
    title: presentation.title,
    theme: presentation.theme,
    group: presentation.group ?? null,
    style: presentation.style ?? null,
    slides,
    hashes,
    templates: [...new Set([...Object.keys(TEMPLATES), ...Object.keys(presentation.templates ?? {})])],
    types: Object.keys(presentation.blueprint?.types ?? {}),
  };
}

/** POST /api/decks/:id/preview: renders a draft (or the saved slide) as a standalone document. */
export async function previewSlide(
  root: string,
  id: string,
  slideId: string | null,
  draft: SlideDraft | null,
): Promise<{ html: string; violations: [] }> {
  const deck = await findDeck(root, id);
  const presentation = await loadDeck(deck);
  const index = slideId == null ? 0 : slideIndex(deck, presentation, slideId);
  try {
    return {
      html: await renderSlideDocument(presentation, index, { draft, assetBase: assetBase(id) }),
      violations: [],
    };
  } catch (error) {
    renderError(error);
  }
}

/** Maps a core write error to the API error. `where` names the file or slide in the message. */
function writeFailure(error: unknown, where: string, conflict: string): never {
  if (error instanceof FileConflictError) {
    throw new StudioError(409, "FILE_CONFLICT", conflict, {
      path: where,
      details: { currentHash: error.currentHash },
    });
  }
  if (error instanceof LastSlideError) {
    throw new StudioError(422, "LAST_SLIDE", "A deck needs at least one slide.", { path: where });
  }
  if (error instanceof ValidationError) {
    if (error.code === "SLIDE_NOT_FOUND")
      throw new StudioError(404, "SLIDE_NOT_FOUND", error.message, { path: where });
    throw new StudioError(422, "VALIDATION_FAILED", error.message, {
      details: { field: error.field ?? null, fields: error.fields ?? [] },
    });
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code && WRITE_ERRORS.has(code)) {
    throw new StudioError(500, "WRITE_FAILED", `Could not write ${where}: ${code}.`, { path: where });
  }
  throw error;
}

/** PUT /api/decks/:id/slides/:slideId: hash-checked save that changes only what changed. */
export async function saveSlide(
  root: string,
  id: string,
  slideId: string,
  baseHash: string,
  draft: SlideDraft,
): Promise<{ slide: SlideDoc; hashes: Record<string, string>; violations: [] }> {
  const deck = await findDeck(root, id);
  let saved: { slideId: string; hashes: Record<string, string> };
  try {
    saved = await updateSlide(deck.absolute, slideId, draft, baseHash);
  } catch (error) {
    writeFailure(error, slideId, "The slide changed on disk since you opened it.");
  }
  const presentation = await loadDeck(deck);
  const index = slideIndex(deck, presentation, saved.slideId);
  const { doc } = await slideDoc(deck, presentation, id, index);
  return { slide: doc, hashes: saved.hashes, violations: [] };
}

const STRUCTURE_CONFLICT = "The deck changed on disk since you opened it.";

/** The file a structure change writes: the manifest, or the single file. */
const structureFile = (deck: DeckEntry) =>
  deck.kind === "folder" ? "presentation.yml" : path.basename(deck.absolute);

async function structureResult(deck: DeckEntry, id: string) {
  const presentation = await loadDeck(deck);
  return { presentation, ...(await deckSlides(deck, presentation, id)), violations: [] as [] };
}

/** POST /api/decks/:id/slides: adds a slide after `afterSlideId` (null: first). */
export async function addSlide(
  root: string,
  id: string,
  afterSlideId: string | null,
  baseHash: string,
  draft: SlideDraft,
): Promise<StructureResponse & { slide: SlideDoc }> {
  const deck = await findDeck(root, id);
  let added: { slideId: string };
  try {
    added = await insertSlide(deck.absolute, afterSlideId, draft, baseHash);
  } catch (error) {
    writeFailure(error, structureFile(deck), STRUCTURE_CONFLICT);
  }
  const { presentation, slides, hashes, violations } = await structureResult(deck, id);
  const slide = slides[slideIndex(deck, presentation, added.slideId)]!;
  return { slide, slides, hashes, violations };
}

/** DELETE /api/decks/:id/slides/:slideId?baseHash=… */
export async function deleteSlide(
  root: string,
  id: string,
  slideId: string,
  baseHash: string,
): Promise<StructureResponse> {
  const deck = await findDeck(root, id);
  try {
    await removeSlide(deck.absolute, slideId, baseHash);
  } catch (error) {
    writeFailure(error, structureFile(deck), STRUCTURE_CONFLICT);
  }
  const { slides, hashes, violations } = await structureResult(deck, id);
  return { slides, hashes, violations };
}

/** PUT /api/decks/:id/order: `slideIds` is a permutation of the deck's slides. */
export async function orderSlides(
  root: string,
  id: string,
  slideIds: string[],
  baseHash: string,
): Promise<StructureResponse> {
  const deck = await findDeck(root, id);
  try {
    await reorderSlides(deck.absolute, slideIds, baseHash);
  } catch (error) {
    writeFailure(error, structureFile(deck), STRUCTURE_CONFLICT);
  }
  const { slides, hashes, violations } = await structureResult(deck, id);
  return { slides, hashes, violations };
}

/** Resolves a `files/*` request inside the deck folder (or the folder holding a single-file deck). */
export async function deckFile(root: string, id: string, relative: string): Promise<string> {
  const deck = await findDeck(root, id);
  const base = deck.kind === "folder" ? deck.absolute : path.dirname(deck.absolute);
  const file = await resolveInside(base, relative);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new StudioError(404, "NOT_FOUND", "File not found.", { path: relative });
  return file;
}

/** Core error codes from createDeck and the HTTP status each maps to. */
const CREATE_ERRORS = {
  DECK_EXISTS: 409,
  KIT_NOT_FOUND: 404,
  KIT_INVALID: 422,
  VALIDATION_FAILED: 422,
} as const;

/** POST /api/decks: creates the deck through core and returns its ID. */
export async function createWorkspaceDeck(root: string, request: CreateDeckRequest): Promise<{ id: string }> {
  try {
    const created = await createDeck(root, request);
    const relative = path.relative(await fs.realpath(root), created.path);
    return { id: encodeDeckId(relative) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code in CREATE_ERRORS) {
      const known = code as keyof typeof CREATE_ERRORS;
      const where = (error as { path?: string }).path;
      const fields = (error as { fields?: unknown }).fields;
      throw new StudioError(CREATE_ERRORS[known], known, (error as Error).message, {
        ...(where ? { path: path.basename(where) } : {}),
        ...(fields ? { details: { fields } } : {}),
      });
    }
    throw error;
  }
}
