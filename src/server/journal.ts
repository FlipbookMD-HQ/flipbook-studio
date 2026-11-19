import fs from "node:fs/promises";
import path from "node:path";
import { atomicCreate, atomicWrite, hashBytes, removeFile } from "@flipbook-md/core";
import type { History } from "../shared/api.js";
import { StudioError } from "./errors.js";
import { TMP_DIR, type DeckEntry } from "./workspace.js";

// US-17 (tech-spec D21): an in-memory change journal per deck. Each deck write snapshots the
// deck's files before and after it runs and records only the files that changed, so undo and
// redo can put back exact bytes. Nothing here survives a restart.

export const MAX_STEPS = 50;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
/** Files larger than this are never snapshotted (and so never restored). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Folders inside a deck that are never part of its history. */
export const SKIP_DIRS = new Set(["node_modules", "exports", "dist", TMP_DIR]);

/** A file's bytes, or null when it doesn't exist. */
export type Bytes = Buffer | null;
export interface FileChange {
  /** Relative to the journal root (the deck folder, or the single file's folder). */
  path: string;
  before: Bytes;
  after: Bytes;
}
export interface Step {
  label: string;
  files: FileChange[];
}
type Snapshot = Map<string, Buffer>;
interface Cached {
  size: number;
  mtimeMs: number;
  ino: number;
  bytes: Buffer;
}

const sizeOf = (step: Step) =>
  step.files.reduce((sum, file) => sum + (file.before?.length ?? 0) + (file.after?.length ?? 0), 0);
const sameBytes = (a: Bytes, b: Bytes) => (a === null || b === null ? a === b : a.equals(b));
const hashOf = (bytes: Bytes) => (bytes ? hashBytes(bytes) : null);

/** Where a deck's journaled files live, and which of them belong to it. */
export function journalRoot(deck: DeckEntry): string {
  return deck.kind === "folder" ? deck.absolute : path.dirname(deck.absolute);
}

/**
 * True when the journal snapshots this path (relative to the journal root, `/`-separated), so a
 * write to it can be undone: no hidden segment, no skipped folder, and for a single-file deck
 * only its own file or a file directly in the shared `assets/` folder.
 */
export function journalCovers(deck: DeckEntry, relative: string): boolean {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part.startsWith(".") || part === "..")) return false;
  if (deck.kind === "single")
    return relative === path.basename(deck.absolute) || (parts.length === 2 && parts[0] === "assets");
  return !parts.slice(0, -1).some((part) => SKIP_DIRS.has(part));
}

/** Files larger than this are never part of a journal step. */
export const MAX_JOURNALED_FILE_BYTES = MAX_FILE_BYTES;

class DeckHistory {
  undo: Step[] = [];
  redo: Step[] = [];
  /** Bytes already read, reused while a file's size, mtime and inode are unchanged. */
  cache = new Map<string, Cached>();
  /** Serializes this deck's journaled writes, undos and redos. */
  queue: Promise<unknown> = Promise.resolve();

  history(): History {
    return { undo: this.undo.at(-1)?.label ?? null, redo: this.redo.at(-1)?.label ?? null };
  }
}

export class DeckJournal {
  private decks = new Map<string, DeckHistory>();

  private entry(deck: DeckEntry): DeckHistory {
    let entry = this.decks.get(deck.relative);
    if (!entry) this.decks.set(deck.relative, (entry = new DeckHistory()));
    return entry;
  }

  history(deck: DeckEntry): History {
    return this.entry(deck).history();
  }

  /** Runs `task` after every earlier journaled task on this deck has finished. */
  private serial<T>(deck: DeckEntry, task: () => Promise<T>): Promise<T> {
    const entry = this.entry(deck);
    const run = entry.queue.then(task, task);
    entry.queue = run.catch(() => undefined);
    return run;
  }

  /** The deck's files: a folder deck's tree, or a single file plus the shared `assets/` folder. */
  async snapshot(deck: DeckEntry): Promise<Snapshot> {
    const entry = this.entry(deck);
    const root = journalRoot(deck);
    const files: string[] = [];
    if (deck.kind === "folder") {
      const walk = async (dir: string) => {
        for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (item.name.startsWith(".")) continue;
          const absolute = path.join(dir, item.name);
          if (item.isDirectory()) {
            if (!SKIP_DIRS.has(item.name)) await walk(absolute);
          } else if (item.isFile()) files.push(path.relative(root, absolute));
        }
      };
      await walk(root);
    } else {
      files.push(path.basename(deck.absolute));
      for (const item of await fs
        .readdir(path.join(root, "assets"), { withFileTypes: true })
        .catch(() => [])) {
        if (item.isFile() && !item.name.startsWith(".")) files.push(path.join("assets", item.name));
      }
    }
    const snapshot: Snapshot = new Map();
    for (const relative of files) {
      const absolute = path.join(root, relative);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const cached = entry.cache.get(relative);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
        snapshot.set(relative, cached.bytes);
        continue;
      }
      const bytes = await fs.readFile(absolute).catch(() => null);
      if (!bytes) continue;
      entry.cache.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, bytes });
      snapshot.set(relative, bytes);
    }
    for (const relative of entry.cache.keys()) if (!snapshot.has(relative)) entry.cache.delete(relative);
    return snapshot;
  }

  /** Records the files that differ between two snapshots as one step; clears redo. */
  record(deck: DeckEntry, label: string, before: Snapshot, after: Snapshot): void {
    const files: FileChange[] = [];
    for (const relative of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(relative) ?? null;
      const b = after.get(relative) ?? null;
      if (!sameBytes(a, b)) files.push({ path: relative, before: a, after: b });
    }
    if (!files.length) return;
    const entry = this.entry(deck);
    entry.redo = [];
    const step = { label, files: files.sort((x, y) => x.path.localeCompare(y.path)) };
    if (sizeOf(step) > MAX_JOURNAL_BYTES) {
      // Too big to keep: clear history so an undo can never skip over this change.
      entry.undo = [];
      return;
    }
    entry.undo.push(step);
    let total = entry.undo.reduce((sum, item) => sum + sizeOf(item), 0);
    while (entry.undo.length > MAX_STEPS || total > MAX_JOURNAL_BYTES) total -= sizeOf(entry.undo.shift()!);
  }

  /**
   * Runs a deck write and records what it changed under `label` (computed from its result).
   * Changes are recorded even when the write throws part-way, so they can still be undone.
   */
  journaled<T>(deck: DeckEntry, label: (result: T | undefined) => string, run: () => Promise<T>): Promise<T> {
    return this.serial(deck, async () => {
      const before = await this.snapshot(deck);
      let result: T | undefined;
      try {
        result = await run();
        return result;
      } finally {
        this.record(deck, label(result), before, await this.snapshot(deck));
      }
    });
  }

  undo(deck: DeckEntry): Promise<History> {
    return this.serial(deck, () => this.move(deck, "undo"));
  }

  redo(deck: DeckEntry): Promise<History> {
    return this.serial(deck, () => this.move(deck, "redo"));
  }

  private async move(deck: DeckEntry, direction: "undo" | "redo"): Promise<History> {
    const entry = this.entry(deck);
    const from = direction === "undo" ? entry.undo : entry.redo;
    const to = direction === "undo" ? entry.redo : entry.undo;
    const step = from.at(-1);
    if (!step) {
      throw new StudioError(
        409,
        direction === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO",
        `Nothing to ${direction}.`,
      );
    }
    const root = journalRoot(deck);
    const current = (file: string) => fs.readFile(path.join(root, file)).catch(() => null);
    // Every file must still be exactly what this step left (or, for redo, what undo put back).
    const changed: string[] = [];
    for (const file of step.files) {
      const expected = direction === "undo" ? file.after : file.before;
      if (hashOf(await current(file.path)) !== hashOf(expected)) changed.push(file.path);
    }
    if (changed.length) {
      throw new StudioError(
        409,
        "UNDO_CONFLICT",
        `${changed.join(", ")} changed outside Studio, so this can't be ${direction === "undo" ? "undone" : "redone"}.`,
        { details: { files: changed } },
      );
    }
    await writeChanges(
      root,
      step.files.map((file) =>
        direction === "undo" ? { path: file.path, before: file.after, after: file.before } : file,
      ),
    );
    from.pop();
    to.push(step);
    return entry.history();
  }

  /**
   * US-26 (D38): writes a planned set of file changes as one journal step named by the plan's
   * `label`. `plan` runs inside this deck's queue; each change's `before` is what the file must
   * hold right now.
   * Every file is checked first, with undo's own check (409 UNDO_CONFLICT, nothing written),
   * then written through core's guarded writes. What actually changed is recorded, even when a
   * write fails part-way, so it can still be undone.
   */
  apply<T>(
    deck: DeckEntry,
    plan: () => Promise<{ label: string; changes: FileChange[]; result: T }>,
  ): Promise<T> {
    return this.serial(deck, async () => {
      const { label, changes, result } = await plan();
      const root = journalRoot(deck);
      const changed: string[] = [];
      for (const file of changes) {
        const current = await fs.readFile(path.join(root, file.path)).catch(() => null);
        if (hashOf(current) !== hashOf(file.before)) changed.push(file.path);
      }
      if (changed.length) {
        throw new StudioError(
          409,
          "UNDO_CONFLICT",
          `${changed.join(", ")} changed outside Studio, so nothing was written.`,
          { details: { files: changed } },
        );
      }
      const before = await this.snapshot(deck);
      try {
        await writeChanges(root, changes);
      } finally {
        this.record(deck, label, before, await this.snapshot(deck));
      }
      return result;
    });
  }
}

/** Writes each change's `after` over its `before` (null: delete, or create) through core's guarded writes. */
async function writeChanges(root: string, changes: FileChange[]): Promise<void> {
  for (const file of changes) {
    if (sameBytes(file.before, file.after)) continue;
    const target = path.join(root, file.path);
    if (file.after === null) await removeFile(target, { roots: [root] });
    else if (file.before === null) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicCreate(target, file.after, { roots: [root] });
    } else await atomicWrite(target, file.after, { baseHash: hashBytes(file.before), roots: [root] });
  }
}
