import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { importDeck, loadPresentation, type Violation } from "@flipbook-md/core";
import type { ImportDeckRequest, ImportDeckResponse } from "../shared/api.js";
import { StudioError } from "./errors.js";
import type { SourceStore } from "./sources.js";
import { assertFree, ignoreGenerationTemp, publish, removeRun, type GenerationRuns } from "./temp-decks.js";
import { TMP_DIR, type DeckEntry } from "./workspace.js";

// US-18: "Import as is". Core maps the document (D23) into a temp folder deck (D25), which is
// renamed into the workspace like a generated deck (D17).

/** Core error codes from importDeck and the HTTP status each maps to. */
const IMPORT_ERRORS = {
  KIT_NOT_FOUND: 404,
  KIT_INVALID: 422,
  VALIDATION_FAILED: 422,
} as const;

function importFailure(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code in IMPORT_ERRORS) {
    const known = code as keyof typeof IMPORT_ERRORS;
    const fields = (error as { fields?: unknown }).fields;
    throw new StudioError(IMPORT_ERRORS[known], known, (error as Error).message, {
      ...(fields ? { details: { fields } } : {}),
    });
  }
  throw error;
}

/** POST /api/decks/import: 409 DECK_EXISTS keeps the temp deck for Save as (details.runId). */
export async function importSource(
  root: string,
  sources: SourceStore,
  runs: GenerationRuns,
  request: ImportDeckRequest,
  log?: (line: string) => void,
): Promise<ImportDeckResponse> {
  const source = await sources.get(root, request.sourceId);
  await assertFree(root, request.name);
  const runId = randomUUID();
  const dir = path.join(root, TMP_DIR, runId);
  let keep = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await ignoreGenerationTemp(root).catch((error) =>
      log?.(`Could not update .gitignore: ${(error as Error).message}`),
    );
    let imported;
    try {
      imported = await importDeck(dir, {
        name: request.name,
        title: request.title,
        group: request.group,
        markdown: source.markdown,
        images: source.images.map((image) => ({ fileName: image.fileName, bytes: image.bytes })),
      });
    } catch (error) {
      importFailure(error);
    }
    // The temp deck now holds everything the source had.
    await sources.consume(root, request.sourceId);
    const deck: DeckEntry = { relative: request.name, absolute: imported.path, kind: "folder" };
    let deckId: string;
    try {
      deckId = await publish(root, deck, request.name, runId);
    } catch (error) {
      if (error instanceof StudioError && error.code === "DECK_EXISTS") {
        keep = true;
        runs.keep(runId, { dir, deck });
      }
      throw error;
    }
    const { violations } = await loadPresentation(deck.absolute, { blueprint: "evaluate" });
    // Dropped items are the ones the preview listed: the reader's, the image checks', the mapping's.
    return { deckId, dropped: source.document.dropped, violations: violations as Violation[] };
  } finally {
    if (!keep) await removeRun(dir);
  }
}
