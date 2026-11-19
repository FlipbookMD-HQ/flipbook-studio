import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StudioError } from "../errors.js";
import { resolveInside } from "../paths.js";
import { TMP_DIR, type DeckEntry } from "../workspace.js";
import type { GitRunner } from "./git.js";
import { checkSha, readVersion, type Skipped } from "./restore.js";

// US-27 (tech-spec D39, D17): a past version of a deck, copied out of git into
// `<workspace>/.flipbook-studio-tmp/versions/<key>-<sha>/` so core's own loader and renderer can
// read it. The temp folder is excluded from scans and emptied at startup; at most
// MAX_VERSION_COPIES copies are kept, the least recently used removed first.

export const MAX_VERSION_COPIES = 10;
export const VERSIONS_DIR = "versions";

export interface VersionCopy {
  /** The copy's own folder: `<tmp>/versions/<key>-<sha>`. */
  dir: string;
  /** Where the deck's files are, laid out like its journal root (deck folder, or the single file's folder). */
  root: string;
  /** What core loads: the copied deck folder, or the copied `.slide.md` file. */
  deckPath: string;
  /** Version entries that weren't copied: symlinks and submodules. */
  skipped: Skipped[];
}

const SKIPPED_FILE = "skipped.json";

/** A short, stable key for a deck (its workspace-relative path). */
export const copyKey = (deck: DeckEntry) =>
  crypto.createHash("sha256").update(deck.relative).digest("hex").slice(0, 12);

/** True for a copy-relative path with no empty, `.`/`..` or absolute part. */
const safeRelative = (relative: string) =>
  !path.isAbsolute(relative) &&
  !relative.includes("\0") &&
  relative.split("/").every((part) => part && part !== "." && part !== "..");

export class VersionCopies {
  /** Copy folder names, least recently used first. */
  private order: string[] = [];
  /** Copies being made, so two requests for one version share the work. */
  private pending = new Map<string, Promise<VersionCopy>>();

  constructor(
    private readonly workspace: string,
    private readonly git: GitRunner,
    private readonly max = MAX_VERSION_COPIES,
  ) {}

  /** `<workspace>/.flipbook-studio-tmp/versions`. */
  get base(): string {
    return path.join(this.workspace, TMP_DIR, VERSIONS_DIR);
  }

  private layout(deck: DeckEntry, dir: string, skipped: Skipped[]): VersionCopy {
    const root = path.join(dir, "deck");
    const deckPath = deck.kind === "folder" ? root : path.join(root, path.basename(deck.absolute));
    return { dir, root, deckPath, skipped };
  }

  /**
   * versionCopy(deck, sha): the deck at version `sha`, copied to a temp folder (D39). 422 for a
   * malformed sha and 404 VERSION_NOT_FOUND for one outside the deck's log, before anything is
   * written (readVersion's checks). Reads git only: HEAD, refs and the index are never touched.
   */
  copy(deck: DeckEntry, sha: string): Promise<VersionCopy> {
    checkSha(sha);
    const name = `${copyKey(deck)}-${sha}`;
    let running = this.pending.get(name);
    if (!running) {
      running = this.make(deck, sha, name).finally(() => this.pending.delete(name));
      this.pending.set(name, running);
    }
    return running;
  }

  private async make(deck: DeckEntry, sha: string, name: string): Promise<VersionCopy> {
    const dir = path.join(this.base, name);
    const kept = await fs.readFile(path.join(dir, SKIPPED_FILE), "utf8").catch(() => null);
    if (kept !== null && this.order.includes(name)) {
      this.use(name);
      return this.layout(deck, dir, JSON.parse(kept) as Skipped[]);
    }
    const version = await readVersion(deck, sha, this.git);
    if (!version.files.size)
      throw new StudioError(404, "VERSION_NOT_FOUND", "The deck has no files in that version.");
    // Built in a staging folder and renamed, so a copy is never seen half-written.
    await fs.mkdir(this.base, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.base, ".staging-"));
    try {
      const root = path.join(staging, "deck");
      for (const [relative, bytes] of version.files) {
        if (!safeRelative(relative)) continue;
        const target = path.join(root, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: "wx" });
      }
      await fs.writeFile(path.join(staging, SKIPPED_FILE), JSON.stringify(version.skipped));
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(staging, dir);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    this.use(name);
    await this.prune();
    return this.layout(deck, dir, version.skipped);
  }

  private use(name: string): void {
    this.order = [...this.order.filter((entry) => entry !== name), name];
  }

  /** Removes the least recently used copies beyond the limit. */
  private async prune(): Promise<void> {
    while (this.order.length > this.max) {
      const oldest = this.order.shift()!;
      await fs.rm(path.join(this.base, oldest), { recursive: true, force: true });
    }
  }

  /**
   * GET …/versions/:sha/files/*: a file inside the version copy. Refuses any `..`, `.` or empty
   * segment, absolute paths, NUL bytes and hidden files (403 PATH_OUTSIDE_ROOT), and anything
   * whose real path leaves the copy; 404 when the version has no such file.
   */
  async file(deck: DeckEntry, sha: string, relative: string): Promise<string> {
    const refuse = () => {
      throw new StudioError(403, "PATH_OUTSIDE_ROOT", "File is outside the version.", { path: relative });
    };
    if (/\\/.test(relative) || !safeRelative(relative)) refuse();
    if (relative.split("/").some((part) => part.startsWith("."))) refuse();
    const copy = await this.copy(deck, sha);
    const file = await resolveInside(copy.root, relative).catch((error: unknown) => {
      if (error instanceof StudioError) refuse();
      throw error;
    });
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile()) throw new StudioError(404, "NOT_FOUND", "File not found.", { path: relative });
    return file;
  }
}
