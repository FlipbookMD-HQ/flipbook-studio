import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, hashBytes } from "@flipbook-md/core";
import { StudioError } from "./errors.js";
import { encodeDeckId } from "./paths.js";
import { TMP_DIR, type DeckEntry } from "./workspace.js";

// Decks built in `<workspace>/.flipbook-studio-tmp/<runId>/` and renamed into the workspace when
// done (D17): AI generation (US-13) and file import (US-18) share this.

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
export async function assertFree(dir: string, entry: string, runId?: string): Promise<void> {
  const entries = await fs.readdir(dir);
  if (entries.some((name) => name.toLowerCase() === entry.toLowerCase())) {
    throw new StudioError(409, "DECK_EXISTS", `A deck named ${entry} already exists. Pick another name.`, {
      path: entry,
      ...(runId ? { details: { runId } } : {}),
    });
  }
}

/** Removes a run folder, and the temp folder too once it's empty, so a cancel leaves the workspace as it was. */
export async function removeRun(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rmdir(path.dirname(dir)).catch(() => {});
}

export const entryName = (name: string, kind: "folder" | "single") =>
  kind === "folder" ? name : `${name}.slide.md`;

export interface Run {
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
export async function publish(root: string, deck: DeckEntry, name: string, runId?: string): Promise<string> {
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
