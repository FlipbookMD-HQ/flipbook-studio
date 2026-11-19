import fs from "node:fs/promises";
import path from "node:path";
import { assetReferences, loadSingleFile } from "@flipbook-md/core";
import { SHA } from "../../shared/api.js";
import { StudioError } from "../errors.js";
import {
  MAX_JOURNALED_FILE_BYTES,
  SKIP_DIRS,
  journalCovers,
  journalRoot,
  type DeckJournal,
  type FileChange,
} from "../journal.js";
import type { DeckEntry } from "../workspace.js";
import type { GitRunner } from "./git.js";
import { locate, pathspecIn, type DeckHistoryService } from "./versions.js";

// US-26 (tech-spec D38, D42): reading a past version of a deck, and putting the deck back to it
// (Restore) or to its latest version (Discard). Both are journaled writes, never git writes: no
// commit, no checkout or reset, and HEAD, refs and the index are left exactly as they were.

export interface Skipped {
  /** Relative to the deck's folder (or the single file's folder). */
  path: string;
  reason: string;
}

export interface VersionFiles {
  /** Path (relative to the deck's folder, or the single file's folder, `/`-separated) → bytes. */
  files: Map<string, Buffer>;
  /** Entries that aren't written: symlinks and submodules. */
  skipped: Skipped[];
}

type Repo = { repoRoot: string; deckRel: string };

const nul = (buffer: Buffer) => buffer.toString("utf8").split("\0").filter(Boolean);
const toPosix = (file: string) => file.split(path.sep).join("/");
const notFound = () =>
  new StudioError(404, "VERSION_NOT_FOUND", "That version isn't in this deck's history.");

/** 422 for anything that isn't a full 40- or 64-character hex sha, before git ever sees it (D43). */
export function checkSha(sha: string): void {
  if (!SHA.test(sha))
    throw new StudioError(422, "VALIDATION_FAILED", "Not a version ID.", { details: { field: "sha" } });
}

/** The deck's repository, or the same errors Save version gives when there isn't a usable one. */
async function repoOf(deck: DeckEntry, git: GitRunner) {
  const located = await locate(deck, git);
  if (located.kind === "no-git") throw new StudioError(503, "GIT_NOT_INSTALLED", located.reason);
  if (located.kind === "no-repo")
    throw new StudioError(409, "GIT_NOT_A_REPO", "This deck isn't in a git repository. Set up git first.");
  if (located.kind === "unsupported")
    throw new StudioError(409, "GIT_NOT_A_REPO", located.reason, {
      details: { state: "unsupported", repoRoot: located.repoRoot },
    });
  return located;
}

// Every sha reaching git below has passed checkSha (hex only), so git can't read it as an option.

/** Throws 404 VERSION_NOT_FOUND unless `sha` is a commit in the deck's log (reachable, touching it). */
async function checkInLog(repo: Repo, spec: string[], sha: string, git: GitRunner): Promise<void> {
  const opts = { cwd: repo.repoRoot, repo: repo.repoRoot, read: true, okCodes: [0, 1] };
  const known = await git.run(["rev-parse", "-q", "--verify", `${sha}^{commit}`], opts);
  if (known.code !== 0 || known.stdout.toString("utf8").trim() !== sha) throw notFound();
  const head = await git.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], opts);
  if (head.code !== 0) throw notFound();
  const reachable = await git.run(["merge-base", "--is-ancestor", sha, "HEAD"], opts);
  if (reachable.code !== 0) throw notFound();
  const { stdout } = await git.run(["log", "-n1", "--format=%H", "--end-of-options", sha, "--", ...spec], {
    ...opts,
    okCodes: [0],
  });
  if (stdout.toString("utf8").trim() !== sha) throw notFound();
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  /** Relative to the repository root. */
  path: string;
}

/** `git ls-tree -r -z --full-tree <sha> -- <paths>` (plain prefix paths: ls-tree has no pathspec magic). */
async function lsTree(repo: Repo, sha: string, paths: string[], git: GitRunner): Promise<TreeEntry[]> {
  const { stdout } = await git.run(
    ["ls-tree", "-r", "-z", "--full-tree", sha, ...(paths.length ? ["--", ...paths] : [])],
    { cwd: repo.repoRoot, repo: repo.repoRoot, read: true },
  );
  return nul(stdout).flatMap((record) => {
    const tab = record.indexOf("\t");
    const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
    return tab > 0 ? [{ mode, type, oid, path: record.slice(tab + 1) }] : [];
  });
}

/** Reads each entry as a checkout would write it (D42); symlinks and submodules are skipped. */
async function readEntries(
  repo: Repo,
  entries: { entry: TreeEntry; relative: string }[],
  git: GitRunner,
): Promise<VersionFiles> {
  const files = new Map<string, Buffer>();
  const skipped: Skipped[] = [];
  for (const { entry, relative } of entries) {
    if (entry.mode === "120000") skipped.push({ path: relative, reason: "symlink" });
    else if (entry.mode === "160000" || entry.type === "commit")
      skipped.push({ path: relative, reason: "submodule" });
    else if (entry.type === "blob") {
      const { stdout } = await git.run(["cat-file", "--filters", `--path=${entry.path}`, entry.oid], {
        cwd: repo.repoRoot,
        repo: repo.repoRoot,
        read: true,
      });
      files.set(relative, stdout);
    }
  }
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/** The deck's files at `sha`, keyed relative to the deck (the journal root). */
async function readTree(deck: DeckEntry, repo: Repo, sha: string, git: GitRunner): Promise<VersionFiles> {
  const { repoRoot, deckRel } = repo;
  if (deck.kind === "folder") {
    const prefix = deckRel ? `${deckRel}/` : "";
    const entries = (await lsTree(repo, sha, deckRel ? [deckRel] : [], git)).flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const relative = entry.path.slice(prefix.length);
      // Same exclusions as the deck's path spec (D37): dist, exports, node_modules, the temp folder.
      if (
        relative
          .split("/")
          .slice(0, -1)
          .some((part) => SKIP_DIRS.has(part))
      )
        return [];
      return [{ entry, relative }];
    });
    return readEntries(repo, entries, git);
  }

  // A single-file deck: its own file, plus the images in the shared assets/ folder that this
  // version of the file references (D18), as the path spec defines it (D37).
  const folder = path.dirname(deck.absolute);
  const name = path.basename(deck.absolute);
  const own = (await lsTree(repo, sha, [deckRel], git)).filter((entry) => entry.path === deckRel);
  const read = await readEntries(
    repo,
    own.map((entry) => ({ entry, relative: name })),
    git,
  );
  const text = read.files.get(name);
  if (text === undefined) return read;
  let references: string[] = [];
  try {
    const presentation = await loadSingleFile(deck.absolute, {
      blueprint: "evaluate",
      overrides: new Map([[deck.absolute, { text: text.toString("utf8") }]]),
    });
    references = [...new Set((await assetReferences(presentation)).map((reference) => reference.path))];
  } catch {
    // A version that doesn't load still has its own file.
  }
  const assets = references
    .map((reference) => path.resolve(folder, reference))
    .filter((absolute) => path.dirname(absolute) === path.join(folder, "assets"))
    .map((absolute) => toPosix(path.relative(repoRoot, absolute)));
  if (!assets.length) return read;
  const wanted = new Set(assets);
  const entries = (await lsTree(repo, sha, [...wanted], git))
    .filter((entry) => wanted.has(entry.path))
    .map((entry) => ({ entry, relative: toPosix(path.relative(folder, path.join(repoRoot, entry.path))) }));
  const assetFiles = await readEntries(repo, entries, git);
  for (const [file, bytes] of assetFiles.files) read.files.set(file, bytes);
  read.skipped.push(...assetFiles.skipped);
  return read;
}

/**
 * D42: the deck's files at version `sha`, read with `git ls-tree -r -z` and
 * `git cat-file --filters --path`, so line endings and filters match a checkout. Symlink and
 * submodule entries are skipped and reported. 422 for a malformed sha (before git runs), 404
 * VERSION_NOT_FOUND for a sha outside the deck's log. Reads only: no git state changes.
 */
export async function readVersion(deck: DeckEntry, sha: string, git: GitRunner): Promise<VersionFiles> {
  checkSha(sha);
  const located = await repoOf(deck, git);
  await checkInLog(located, await pathspecIn(deck, located, git), sha, git);
  return readTree(deck, located, sha, git);
}

export interface RestoreResult {
  /** Files in the version that weren't written: symlinks, submodules, hidden or very large files. */
  skipped: Skipped[];
}

/** Repo-relative `ls-files` paths → paths relative to the deck's journal root. */
const deckRelative = (deck: DeckEntry, repoRoot: string, files: string[]) =>
  files.map((file) => toPosix(path.relative(journalRoot(deck), path.join(repoRoot, file))));

/**
 * The changes that make the deck's files equal `target`. `remove` lists files in the deck now that
 * aren't in the version and should be deleted. Files the journal can't snapshot (hidden, inside a
 * skipped folder, over 16 MB) are left alone and reported, so Undo always puts back exact bytes.
 */
async function planChanges(
  deck: DeckEntry,
  target: VersionFiles,
  remove: string[],
): Promise<{ changes: FileChange[]; skipped: Skipped[] }> {
  if (!target.files.size)
    throw new StudioError(404, "VERSION_NOT_FOUND", "The deck has no files in that version.");
  const root = journalRoot(deck);
  const current = (file: string) => fs.readFile(path.join(root, file)).catch(() => null);
  const skipped = [...target.skipped];
  const leave = new Set(skipped.map((item) => item.path));
  const changes: FileChange[] = [];
  for (const [file, after] of target.files) {
    if (!journalCovers(deck, file)) skipped.push({ path: file, reason: "hidden file (not part of Undo)" });
    else if (after.length > MAX_JOURNALED_FILE_BYTES)
      skipped.push({ path: file, reason: "larger than 16 MB (not part of Undo)" });
    else {
      const before = await current(file);
      if (!before || !before.equals(after)) changes.push({ path: file, before, after });
    }
  }
  for (const file of remove) {
    if (target.files.has(file) || leave.has(file) || !journalCovers(deck, file)) continue;
    const before = await current(file);
    if (before && before.length <= MAX_JOURNALED_FILE_BYTES)
      changes.push({ path: file, before, after: null });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, skipped };
}

/** POST …/restore and …/discard: whole-deck restores as single journal steps (US-26, D38). */
export class DeckRestorer {
  constructor(
    private readonly deps: { git: GitRunner; versions: DeckHistoryService; journal: DeckJournal },
  ) {}

  private get git() {
    return this.deps.git;
  }

  /** The deck's history, which must be ready and still at `expectHead` (409 VERSION_STALE). */
  private async current(deck: DeckEntry, expectHead: string) {
    const located = await repoOf(deck, this.git);
    const state = await this.deps.versions.state(deck);
    if (state.state !== "ready")
      throw new StudioError(409, "GIT_NOT_A_REPO", state.reason ?? "Version history isn't available.");
    if (state.head?.sha !== expectHead)
      throw new StudioError(
        409,
        "VERSION_STALE",
        "The deck's latest version changed since History loaded. Reload and try again.",
        { details: { head: state.head?.sha ?? null } },
      );
    const spec = await pathspecIn(deck, located, this.git);
    return { located, state, spec };
  }

  private async lsFiles(repoRoot: string, spec: string[], which: "--cached" | "--others") {
    const { stdout } = await this.git.run(
      ["ls-files", "-z", which, ...(which === "--others" ? ["--exclude-standard"] : []), "--", ...spec],
      { cwd: repoRoot, repo: repoRoot, read: true },
    );
    return nul(stdout);
  }

  private async note(repoRoot: string, sha: string): Promise<string> {
    const { stdout } = await this.git.run(["log", "-n1", "--format=%s", "--end-of-options", sha], {
      cwd: repoRoot,
      repo: repoRoot,
      read: true,
    });
    return stdout.toString("utf8").trim();
  }

  /**
   * Puts the deck's files back to version `sha`: its bytes are written, and files tracked now
   * but missing in it are deleted. Untracked and ignored files are never touched. A single-file
   * deck's images in the shared assets/ folder are written but never deleted (other decks may
   * use them). 409 DECK_DIRTY (with `details.changes`) when the deck has unsaved-version changes.
   */
  restore(deck: DeckEntry, sha: string, expectHead: string): Promise<RestoreResult> {
    checkSha(sha);
    return this.deps.journal.apply(deck, async () => {
      const { located, state, spec } = await this.current(deck, expectHead);
      await checkInLog(located, spec, sha, this.git);
      if (state.dirty)
        throw new StudioError(
          409,
          "DECK_DIRTY",
          "The deck has changes since its last version. Save a version or discard them first.",
          { details: { changes: state.changes } },
        );
      const target = await readTree(deck, located, sha, this.git);
      const tracked = deckRelative(
        deck,
        located.repoRoot,
        await this.lsFiles(located.repoRoot, spec, "--cached"),
      );
      const name = path.basename(deck.absolute);
      const remove = deck.kind === "folder" ? tracked : tracked.filter((file) => file === name);
      const { changes, skipped } = await planChanges(deck, target, remove);
      return { label: `Restore "${await this.note(located.repoRoot, sha)}"`, changes, result: { skipped } };
    });
  }

  /**
   * Puts back the deck's latest version and deletes new files in the deck that aren't ignored.
   * 409 NO_CHANGES when there's nothing to discard.
   */
  discard(deck: DeckEntry, expectHead: string): Promise<RestoreResult> {
    checkSha(expectHead);
    return this.deps.journal.apply(deck, async () => {
      const { located, state, spec } = await this.current(deck, expectHead);
      const head = state.head!;
      if (!state.dirty) throw new StudioError(409, "NO_CHANGES", "No changes since the last version.");
      const target = await readTree(deck, located, head.sha, this.git);
      const { repoRoot } = located;
      const untracked = deckRelative(deck, repoRoot, await this.lsFiles(repoRoot, spec, "--others"));
      const tracked = deckRelative(deck, repoRoot, await this.lsFiles(repoRoot, spec, "--cached"));
      const name = path.basename(deck.absolute);
      // A single file's tracked images stay (shared folder); new ones it added are deleted.
      const remove = [
        ...untracked,
        ...(deck.kind === "folder" ? tracked : tracked.filter((f) => f === name)),
      ];
      const { changes, skipped } = await planChanges(deck, target, remove);
      return { label: `Discard changes since "${head.note}"`, changes, result: { skipped } };
    });
  }
}
