import fs from "node:fs/promises";
import path from "node:path";
import { assetReferences, loadPresentation, loadSingleFile, type Presentation } from "@flipbook-md/core";
import type { GitAuthor, HistoryState, Version } from "../../shared/api.js";
import { StudioError } from "../errors.js";
import { SKIP_DIRS, journalRoot } from "../journal.js";
import type { DeckEntry } from "../workspace.js";
import { GitError, type GitRunner } from "./git.js";

// US-23: a deck's history in git (tech-spec D37). Studio stores nothing: every answer is read
// from git, all output is parsed from -z (NUL-separated) form, and Save version commits only
// the deck's own path spec, leaving the user's other staged and unstaged work as it was.

export interface HistoryDeps {
  git: GitRunner;
  /** The workspace root (absolute, real path). */
  workspace: string;
  /** settings.git.author, used only when git config has no author. */
  author: () => Promise<GitAuthor | undefined>;
}

type Located =
  | { kind: "no-git"; reason: string }
  | { kind: "no-repo" }
  | { kind: "unsupported"; reason: string; repoRoot: string | null }
  | { kind: "repo"; repoRoot: string; gitDir: string; deckRel: string };

const toPosix = (file: string) => file.split(path.sep).join("/");
const nul = (buffer: Buffer) => buffer.toString("utf8").split("\0");
/** Escapes glob characters for a `:(glob)` pathspec. */
const globEscape = (text: string) => text.replace(/[*?[\]\\]/g, "\\$&");
const literal = (rel: string) => `:(top,literal)${rel}`;

const SAFE_DIRECTORY = /dubious ownership|safe\.directory/i;
/** Slides counted by slidesChanged in a folder deck (tech-spec data model). */
const FOLDER_SLIDE = /^slides\/.+\.slide\.md$/;
const MAX_CACHED = 5000;

/** The deck's folder: where git is asked about it. */
const deckDir = (deck: DeckEntry) => journalRoot(deck);

/** Finds the repository a deck is in, and whether Studio can work with it. */
async function locate(deck: DeckEntry, git: GitRunner): Promise<Located> {
  const available = await git.check();
  if (!available.ok) return { kind: "no-git", reason: available.reason };
  const cwd = deckDir(deck);
  let lines: string[];
  try {
    const { stdout } = await git.run(["rev-parse", "--is-bare-repository", "--is-inside-work-tree"], {
      cwd,
      read: true,
    });
    lines = stdout.toString("utf8").split("\n");
  } catch (error) {
    if (error instanceof GitError && error.kind === "not_repo") return { kind: "no-repo" };
    if (error instanceof GitError && SAFE_DIRECTORY.test(error.output))
      return {
        kind: "unsupported",
        reason:
          "Git won't open this repository because another user owns it (safe.directory). Studio doesn't change git config; add it to safe.directory yourself if you trust it.",
        repoRoot: null,
      };
    throw error;
  }
  if (lines[0] === "true" || lines[1] !== "true")
    return {
      kind: "unsupported",
      reason: "The deck is inside a bare repository (no working tree), so versions can't be saved.",
      repoRoot: null,
    };
  const { stdout } = await git.run(
    ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-superproject-working-tree"],
    { cwd, read: true },
  );
  const [top = "", gitDir = "", superproject = ""] = stdout.toString("utf8").split("\n");
  const repoRoot = await fs.realpath(top).catch(() => top);
  if (superproject.trim())
    return {
      kind: "unsupported",
      reason: `The deck is inside a git submodule (${repoRoot}). Save versions from the main repository with git instead.`,
      repoRoot,
    };
  const deckRel = toPosix(path.relative(repoRoot, deck.absolute));
  if (deckRel.startsWith("..") || path.isAbsolute(deckRel))
    return { kind: "unsupported", reason: "The deck is outside its repository's working tree.", repoRoot };

  const mainFile =
    deck.kind === "folder" ? (deckRel ? `${deckRel}/presentation.yml` : "presentation.yml") : deckRel;
  const ignored = await git.run(["check-ignore", "-q", "--", mainFile], {
    cwd: repoRoot,
    repo: repoRoot,
    read: true,
    okCodes: [0, 1],
  });
  if (ignored.code === 0)
    return {
      kind: "unsupported",
      reason: `The deck is ignored by git (.gitignore) in ${repoRoot}, so versions can't be saved.`,
      repoRoot,
    };

  const located = { kind: "repo" as const, repoRoot, gitDir, deckRel };
  const files = await deckFiles(deck, located, git);
  // Paths go in on stdin (NUL-separated), so a big deck never hits the argument limit.
  const attrs = nul(
    (
      await git.run(["check-attr", "-z", "--stdin", "filter"], {
        cwd: repoRoot,
        repo: repoRoot,
        read: true,
        input: [...new Set([mainFile, ...files])].map((file) => `${file}\0`).join(""),
      })
    ).stdout,
  );
  for (let index = 0; index + 2 < attrs.length; index += 3) {
    if (attrs[index + 2] === "lfs")
      return {
        kind: "unsupported",
        reason: `${attrs[index]} is stored with Git LFS, which Studio's history doesn't support.`,
        repoRoot,
      };
  }
  return located;
}

/**
 * The deck's path spec (D37), relative to the repository root with `:(top)` magic: a folder
 * deck's folder minus dist, exports, node_modules and the temp folder; a single-file deck's
 * file plus the files in the shared `assets/` folder it references (that exist or are tracked).
 */
async function pathspecIn(
  deck: DeckEntry,
  repo: { repoRoot: string; deckRel: string },
  git: GitRunner,
): Promise<string[]> {
  const { repoRoot, deckRel } = repo;
  if (deck.kind === "folder") {
    const base = deckRel ? `${globEscape(deckRel)}/` : "";
    return [
      deckRel ? literal(deckRel) : ":(top)",
      ...[...SKIP_DIRS].sort().map((dir) => `:(top,exclude,glob)${base}**/${globEscape(dir)}/**`),
    ];
  }
  let references: string[] = [];
  try {
    const presentation = await loadSingleFile(deck.absolute, { blueprint: "evaluate" });
    references = [...new Set((await assetReferences(presentation)).map((reference) => reference.path))];
  } catch {
    // A deck that doesn't load still has its own file.
  }
  const folder = path.dirname(deck.absolute);
  const assets = references
    .map((reference) => path.resolve(folder, reference))
    // Only the shared assets/ folder next to the file (D18), never a path that leaves it.
    .filter((absolute) => path.dirname(absolute) === path.join(folder, "assets"))
    .map((absolute) => toPosix(path.relative(repoRoot, absolute)));
  const present: string[] = [];
  const missing: string[] = [];
  for (const asset of assets) {
    const exists = await fs
      .lstat(path.join(repoRoot, asset))
      .then(() => true)
      .catch(() => false);
    (exists ? present : missing).push(asset);
  }
  if (missing.length) {
    // A deleted image is still part of the deck if git tracks it (the deletion gets committed).
    const tracked = nul(
      (
        await git.run(["ls-files", "-z", "--", ...missing.map(literal)], {
          cwd: repoRoot,
          repo: repoRoot,
          read: true,
        })
      ).stdout,
    ).filter(Boolean);
    present.push(...tracked);
  }
  return [literal(deckRel), ...present.sort().map(literal)];
}

/** Tracked and untracked (not ignored) files in the deck's path spec, relative to the repo root. */
async function deckFiles(
  deck: DeckEntry,
  repo: { repoRoot: string; deckRel: string },
  git: GitRunner,
): Promise<string[]> {
  const spec = await pathspecIn(deck, repo, git);
  const { stdout } = await git.run(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...spec],
    {
      cwd: repo.repoRoot,
      repo: repo.repoRoot,
      read: true,
    },
  );
  return nul(stdout).filter(Boolean);
}

/** D37: the deck's path spec, or null when the deck isn't in a repository Studio can use. */
export async function deckPathspec(deck: DeckEntry, git: GitRunner): Promise<string[] | null> {
  const located = await locate(deck, git);
  return located.kind === "repo" ? pathspecIn(deck, located, git) : null;
}

/** Parses `git status --porcelain=v1 -z --no-renames` into the deck's changes. */
export function parseStatus(stdout: Buffer, prefix: string): HistoryState["changes"] {
  const changes: HistoryState["changes"] = [];
  for (const entry of nul(stdout)) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    const status = xy === "??" || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified";
    changes.push({ path: prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file, status });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

const emptyState = (state: HistoryState["state"], extra: Partial<HistoryState> = {}): HistoryState => ({
  state,
  reason: null,
  repoRoot: null,
  canInit: { deck: false, workspace: false },
  head: null,
  dirty: false,
  changes: [],
  detached: false,
  ...extra,
});

/** One field per value: sha, parents, author, author time (unix), subject. */
const LOG_FORMAT = "--format=%H%x00%P%x00%an%x00%at%x00%s";
const LOG_FIELDS = 5;

interface LogEntry {
  sha: string;
  parent: string | null;
  author: string;
  time: string;
  note: string;
}

function parseLog(stdout: Buffer): LogEntry[] {
  const fields = nul(stdout);
  const entries: LogEntry[] = [];
  for (let index = 0; index + LOG_FIELDS <= fields.length; index += LOG_FIELDS) {
    // Records end with a NUL too, so a record's first field may start with a newline.
    const sha = fields[index]!.trim();
    if (!sha) break;
    entries.push({
      sha,
      parent: fields[index + 1]!.split(" ").filter(Boolean)[0] ?? null,
      author: fields[index + 2]!,
      time: new Date(Number(fields[index + 3]) * 1000).toISOString(),
      note: fields[index + 4]!,
    });
  }
  return entries;
}

/** A slide's content as compared by position in a single-file deck. */
const slideKey = (slide: Presentation["slides"][number]) =>
  JSON.stringify([slide.markdown, slide.notes, slide.template, slide.type, slide.title]);

export class DeckHistoryService {
  /** `${deck}\0${sha}` → slidesChanged; a commit's diff never changes, so this never goes stale. */
  private slidesCache = new Map<string, number>();

  constructor(private readonly deps: HistoryDeps) {}

  private get git() {
    return this.deps.git;
  }

  /** HistoryState for GET /api/decks/:id/versions and after every write. */
  async state(deck: DeckEntry): Promise<HistoryState> {
    return (await this.stateWith(deck)).history;
  }

  private async stateWith(deck: DeckEntry): Promise<{ history: HistoryState; located: Located | null }> {
    const history = (state: HistoryState, located: Located | null = null) => ({ history: state, located });
    let located: Located;
    try {
      located = await locate(deck, this.git);
    } catch (error) {
      // Git ran but refused in a way Studio doesn't know: report it rather than fail the panel.
      if (error instanceof GitError && error.kind === "failed")
        return history(emptyState("unsupported", { reason: error.message }));
      throw error;
    }
    if (located.kind === "no-git") return history(emptyState("no-git", { reason: located.reason }));
    if (located.kind === "no-repo")
      return history(
        emptyState("no-repo", {
          reason: "This deck isn't in a git repository.",
          canInit: { deck: deck.kind === "folder", workspace: true },
        }),
      );
    if (located.kind === "unsupported")
      return history(emptyState("unsupported", { reason: located.reason, repoRoot: located.repoRoot }));
    const spec = await pathspecIn(deck, located, this.git);
    const opts = { cwd: located.repoRoot, repo: located.repoRoot, read: true };
    const detached =
      (await this.git.run(["symbolic-ref", "-q", "HEAD"], { ...opts, okCodes: [0, 1] })).code === 1;
    const [head = null] = await this.log(deck, located, spec, null, 1);
    const status = await this.git.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...spec],
      opts,
    );
    const folder = toPosix(path.relative(located.repoRoot, deckDir(deck)));
    const changes = parseStatus(status.stdout, folder ? `${folder}/` : "");
    return history(
      emptyState("ready", { repoRoot: located.repoRoot, head, dirty: changes.length > 0, changes, detached }),
      located,
    );
  }

  /** True when the repository has a commit at HEAD. */
  private async hasHead(repoRoot: string): Promise<boolean> {
    const result = await this.git.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], {
      cwd: repoRoot,
      repo: repoRoot,
      read: true,
      okCodes: [0, 1],
    });
    return result.code === 0;
  }

  /** Up to `count` versions touching the deck, newest first, from `from` (default HEAD). */
  private async log(
    deck: DeckEntry,
    repo: { repoRoot: string; deckRel: string },
    spec: string[],
    from: string | null,
    count: number,
  ): Promise<Version[]> {
    if (!(await this.hasHead(repo.repoRoot))) return [];
    let stdout: Buffer;
    try {
      ({ stdout } = await this.git.run(
        [
          "log",
          "-z",
          "--no-ext-diff",
          LOG_FORMAT,
          `-n${count}`,
          "--end-of-options",
          from ?? "HEAD",
          "--",
          ...spec,
        ],
        { cwd: repo.repoRoot, repo: repo.repoRoot, read: true },
      ));
    } catch (error) {
      if (from && error instanceof GitError && error.kind === "failed")
        throw new StudioError(404, "VERSION_NOT_FOUND", "That version isn't in this deck's history.");
      throw error;
    }
    const entries = parseLog(stdout);
    const versions: Version[] = [];
    for (const entry of entries)
      versions.push({
        sha: entry.sha,
        note: entry.note,
        author: entry.author,
        time: entry.time,
        slidesChanged: await this.slidesChanged(deck, repo, spec, entry),
      });
    return versions;
  }

  /** GET /api/decks/:id/versions: a page of the timeline, newest first. */
  async list(
    deck: DeckEntry,
    before: string | undefined,
    limit: number,
  ): Promise<{ history: HistoryState; versions: Version[]; next: string | null }> {
    const { history, located } = await this.stateWith(deck);
    if (!located || located.kind !== "repo") return { history, versions: [], next: null };
    const spec = await pathspecIn(deck, located, this.git);
    let versions: Version[];
    if (before) {
      // `before` is the last version of the previous page: list from it and drop it.
      const page = await this.log(deck, located, spec, before, limit + 2);
      if (page[0]?.sha !== before)
        throw new StudioError(404, "VERSION_NOT_FOUND", "That version isn't in this deck's history.");
      versions = page.slice(1);
    } else versions = await this.log(deck, located, spec, null, limit + 1);
    const more = versions.length > limit;
    versions = versions.slice(0, limit);
    return { history, versions, next: more ? versions.at(-1)!.sha : null };
  }

  private async slidesChanged(
    deck: DeckEntry,
    repo: { repoRoot: string; deckRel: string },
    spec: string[],
    entry: LogEntry,
  ): Promise<number> {
    const key = `${deck.relative}\0${entry.sha}`;
    const cached = this.slidesCache.get(key);
    if (cached !== undefined) return cached;
    const count =
      deck.kind === "folder"
        ? await this.folderSlidesChanged(repo, spec, entry)
        : await this.singleSlidesChanged(deck, repo, entry);
    if (this.slidesCache.size >= MAX_CACHED) this.slidesCache.clear();
    this.slidesCache.set(key, count);
    return count;
  }

  private async folderSlidesChanged(
    repo: { repoRoot: string; deckRel: string },
    spec: string[],
    entry: LogEntry,
  ): Promise<number> {
    const revs = entry.parent ? [entry.parent, entry.sha] : ["--root", entry.sha];
    const { stdout } = await this.git.run(
      [
        "diff-tree",
        "-r",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--name-only",
        "--no-commit-id",
        ...revs,
        "--",
        ...spec,
      ],
      { cwd: repo.repoRoot, repo: repo.repoRoot, read: true },
    );
    const prefix = repo.deckRel ? `${repo.deckRel}/` : "";
    return nul(stdout).filter(
      (file) => file.startsWith(prefix) && FOLDER_SLIDE.test(file.slice(prefix.length)),
    ).length;
  }

  /** Splits both versions into slides with core's loader and compares them by position. */
  private async singleSlidesChanged(
    deck: DeckEntry,
    repo: { repoRoot: string; deckRel: string },
    entry: LogEntry,
  ): Promise<number> {
    const slidesAt = async (rev: string | null): Promise<string[]> => {
      if (!rev) return [];
      let text: string;
      try {
        const { stdout } = await this.git.run(["cat-file", "--filters", `${rev}:${repo.deckRel}`], {
          cwd: repo.repoRoot,
          repo: repo.repoRoot,
          read: true,
        });
        text = stdout.toString("utf8");
      } catch (error) {
        if (error instanceof GitError && error.kind === "failed") return []; // Not in that version.
        throw error;
      }
      try {
        const presentation = await loadSingleFile(deck.absolute, {
          blueprint: "evaluate",
          overrides: new Map([[deck.absolute, { text }]]),
        });
        return presentation.slides.map(slideKey);
      } catch {
        return [];
      }
    };
    const [before, after] = [await slidesAt(entry.parent), await slidesAt(entry.sha)];
    let changed = Math.abs(before.length - after.length);
    for (let index = 0; index < Math.min(before.length, after.length); index += 1)
      if (before[index] !== after[index]) changed += 1;
    return changed;
  }

  /** POST /api/git/init: `git init` only, in the deck's folder or the workspace. No commit. */
  async init(deck: DeckEntry, at: "deck" | "workspace"): Promise<HistoryState> {
    const located = await locate(deck, this.git);
    if (located.kind === "no-git") throw new StudioError(503, "GIT_NOT_INSTALLED", located.reason);
    if (located.kind !== "no-repo")
      throw new StudioError(
        409,
        "GIT_ALREADY_A_REPO",
        `The deck is already in a git repository${"repoRoot" in located && located.repoRoot ? ` (${located.repoRoot})` : ""}.`,
      );
    // A single-file deck's folder is the workspace (decks are top-level).
    const dir = at === "deck" && deck.kind === "folder" ? deck.absolute : this.deps.workspace;
    try {
      await this.git.run(["init", "--quiet"], { cwd: dir });
    } catch (error) {
      throw gitFailure(error, "GIT_COMMIT_FAILED");
    }
    return this.state(deck);
  }

  /** POST /api/decks/:id/versions: commits the deck's path spec only (D37). */
  async save(
    deck: DeckEntry,
    note: string | undefined,
  ): Promise<{ version: Version; history: HistoryState }> {
    const located = await locate(deck, this.git);
    if (located.kind === "no-git") throw new StudioError(503, "GIT_NOT_INSTALLED", located.reason);
    if (located.kind === "no-repo")
      throw new StudioError(409, "GIT_NOT_A_REPO", "This deck isn't in a git repository. Set up git first.");
    if (located.kind === "unsupported")
      throw new StudioError(409, "GIT_NOT_A_REPO", located.reason, {
        details: { state: "unsupported", repoRoot: located.repoRoot },
      });
    const { repoRoot, gitDir } = located;
    const message = note?.trim() || `Save version of "${await deckTitle(deck)}"`;
    const opts = { cwd: repoRoot, repo: repoRoot };

    // Worked out before taking the repo's queue: it may run queued git commands itself.
    const spec = await pathspecIn(deck, located, this.git).catch((error: unknown) => {
      throw gitFailure(error, "GIT_COMMIT_FAILED");
    });
    await this.git
      .serial(repoRoot, async () => {
        // Inside the queue, only runNow: a queued run here would wait for this task forever.
        await this.git.checkNotBusy(gitDir, repoRoot);
        const status = await this.git.runNow(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...spec],
          { ...opts, read: true },
        );
        if (!parseStatus(status.stdout, "").length)
          throw new StudioError(409, "NO_CHANGES", "No changes since the last version.");
        const config = await this.authorConfig(repoRoot);
        await this.git.runNow(["add", "-A", "--", ...spec], { ...opts, config });
        await this.git.runNow(["commit", "--cleanup=whitespace", "-F", "-", "--", ...spec], {
          ...opts,
          config,
          input: `${message}\n`,
        });
      })
      .catch((error: unknown) => {
        throw gitFailure(error, "GIT_COMMIT_FAILED");
      });
    const history = await this.state(deck);
    // The new commit is HEAD and touches the deck, so it is the deck's head version.
    return { version: history.head!, history };
  }

  /** `-c user.name/-c user.email` from Studio settings when git config has no author; else none. */
  private async authorConfig(repoRoot: string): Promise<Record<string, string> | undefined> {
    const get = async (key: string) => {
      const result = await this.git.runNow(["config", "--get", key], {
        cwd: repoRoot,
        read: true,
        okCodes: [0, 1],
      });
      return result.code === 0 ? result.stdout.toString("utf8").trim() : "";
    };
    if ((await get("user.name")) && (await get("user.email"))) return undefined;
    const author = await this.deps.author();
    if (!author)
      throw new StudioError(
        409,
        "GIT_AUTHOR_MISSING",
        "Git doesn't know who you are (no user.name or user.email). Enter the name and email to save versions with.",
      );
    return { "user.name": author.name, "user.email": author.email };
  }
}

async function deckTitle(deck: DeckEntry): Promise<string> {
  try {
    const { presentation } = await loadPresentation(deck.absolute, { blueprint: "evaluate" });
    return presentation.title;
  } catch {
    return deck.relative;
  }
}

/** Maps a GitError to the API's error codes; other errors pass through. */
export function gitFailure(error: unknown, failed: "GIT_COMMIT_FAILED"): unknown {
  if (!(error instanceof GitError)) return error;
  const details = { output: error.output };
  switch (error.kind) {
    case "not_installed":
      return new StudioError(503, "GIT_NOT_INSTALLED", error.message);
    case "not_repo":
      return new StudioError(409, "GIT_NOT_A_REPO", "This deck isn't in a git repository. Set up git first.");
    case "busy":
      return new StudioError(
        409,
        "GIT_BUSY",
        /Finish it/.test(error.message) ? error.message : `${error.message} Finish it, then try again.`,
        { details },
      );
    case "timeout":
      return new StudioError(504, "GIT_TIMEOUT", error.message, { details });
    default:
      return new StudioError(422, failed, error.message, { details });
  }
}
