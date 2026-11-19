import fs from "node:fs/promises";
import path from "node:path";
import { isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import {
  AssetError,
  ValidationError,
  assetBaseName,
  assetReferences,
  checkAsset,
  chunkLayout,
  joinLayout,
  loadPresentation,
  renderSlideDocument,
  type Presentation,
} from "@flipbook-md/core";
import type { RestoredAsset, Version, VersionSlide } from "../../shared/api.js";
import { slideIdAt, slideIndex } from "../decks.js";
import { StudioError } from "../errors.js";
import { journalCovers, journalRoot, type DeckJournal, type FileChange } from "../journal.js";
import type { DeckEntry } from "../workspace.js";
import type { VersionCopies, VersionCopy } from "./copies.js";
import { checkSha, type Skipped } from "./restore.js";
import type { DeckHistoryService } from "./versions.js";

// US-27: a past version's slides (the version view and its previews) and restoring one slide
// from it. A slide restore is one journaled write (D38, D21): no commit, and HEAD, refs and the
// index are never touched. Only that slide, its place in the deck, and its missing images change.

/** Images directly in the deck's `assets/` folder (D18), as core's assetReferences gives them. */
const ASSET_REF = /^assets\/[^/]+$/;
const MAX_NAME_SUFFIX = 999;

// ---------- single-file chunks ----------
// core's chunkLayout splits the way its slide writer does; a restore swaps one chunk's text and
// leaves the separators, blank lines and every other chunk's bytes as they are.

/** Puts `core` at `index` (replacing that chunk), or after the last chunk when `index` is past the end. */
export function placeChunk(text: string, index: number, core: string): { text: string; index: number } {
  const layout = chunkLayout(text);
  if (index < layout.cores.length) {
    layout.cores[index] = core;
    return { text: joinLayout(layout), index };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!layout.cores.length) {
    const head = text.replace(/\s*$/, "");
    return { text: `${head}${head ? `${eol}${eol}` : ""}${core}${eol}`, index: 0 };
  }
  const last = layout.cores.length - 1;
  layout.cores[last] = `${layout.cores[last]}${eol}${eol}---${eol}${eol}${core}`;
  return { text: joinLayout(layout), index: last + 1 };
}

// ---------- folder manifests ----------

const itemSource = (item: unknown): string | undefined => {
  if (isScalar(item)) return typeof item.value === "string" ? item.value : undefined;
  const file = (item as { get?: (key: string) => unknown } | null)?.get?.("file");
  return typeof file === "string" ? file : undefined;
};

/** The manifest's slide entries, in order (strings, or `{ file }` items). */
export function manifestSources(text: string): string[] {
  const slides = parseDocument(text).get("slides", true);
  return isSeq(slides) ? slides.items.flatMap((item) => itemSource(item) ?? []) : [];
}

const quoteLike = (raw: string, value: string) => {
  if (raw.startsWith('"')) return JSON.stringify(value);
  if (raw.startsWith("'")) return `'${value.replace(/'/g, "''")}'`;
  return /^[\w./-]+$/.test(value) ? value : JSON.stringify(value);
};

/**
 * Adds `source` to the manifest's `slides:` list at entry `at` (or last), the way core's add
 * slide does. A block list gets one new line in the style of its neighbours and every other byte
 * stays; any other shape is rewritten through the YAML document.
 */
export function insertManifestEntry(text: string, source: string, at: number): string {
  const doc = parseDocument(text);
  const slides = doc.get("slides", true);
  if (!isSeq(slides))
    throw new StudioError(422, "DECK_LOAD_FAILED", "presentation.yml has no slides list.", {
      path: "presentation.yml",
    });
  const entries = slides.items.flatMap((item, position) =>
    itemSource(item) === undefined ? [] : [{ item: item as YamlNode, position }],
  );
  const neighbour = entries[Math.min(at, entries.length - 1)];
  const plain = entries.every(({ item }) => isScalar(item) && item.range);
  if (!slides.flow && neighbour && plain) {
    const [from, to] = neighbour.item.range!;
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const prefix = text.slice(lineStart, from);
    if (/^\s*-\s+$/.test(prefix)) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const line = `${prefix}${quoteLike(text.slice(from, to), source)}`;
      if (at < entries.length) return `${text.slice(0, lineStart)}${line}${eol}${text.slice(lineStart)}`;
      const lineEnd = text.indexOf("\n", to);
      if (lineEnd === -1) return `${text}${eol}${line}`;
      return `${text.slice(0, lineEnd + 1)}${line}${eol}${text.slice(lineEnd + 1)}`;
    }
  }
  const node = doc.createNode(source);
  const quoted = entries.find(({ item }) => isScalar(item))?.item;
  if (quoted && isScalar(quoted) && quoted.type) node.type = quoted.type;
  slides.items.splice(at < entries.length ? entries[at]!.position : slides.items.length, 0, node);
  return doc.toString();
}

// ---------- images ----------

/** Rewrites a slide's references to `assets/<from>` so they point at `assets/<to>`. */
export function rewriteImage(text: string, from: string, to: string): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text;
  for (const [a, b] of [
    [from, to],
    [encodeURI(from), encodeURI(to)],
  ] as const) {
    const pattern = new RegExp(`((?:^|[^\\w.%-])(?:\\.{1,2}/)*assets/)${escape(a)}(?=$|[^\\w.%-])`, "gm");
    out = out.replace(pattern, (_match, lead: string) => `${lead}${b}`);
  }
  return out;
}

type OnDisk = { kind: "missing" } | { kind: "file"; bytes: Buffer } | { kind: "other" };

async function onDisk(file: string): Promise<OnDisk> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { kind: "missing" };
  if (!stat.isFile()) return { kind: "other" };
  const bytes = await fs.readFile(file).catch(() => null);
  return bytes ? { kind: "file", bytes } : { kind: "other" };
}

/** Names tried when `name` is taken by a different file: the safe name, then `-2`, `-3`… (D19). */
function* candidates(name: string): Generator<string> {
  const safe = assetBaseName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  if (safe !== name) yield safe;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n += 1) yield `${stem}-${n}${ext}`;
}

interface ImagePlan {
  changes: FileChange[];
  /** Image name in the version → the name the slide must use now. */
  renames: Map<string, string>;
  restoredAssets: RestoredAsset[];
  skippedAssets: Skipped[];
}

function skipReason(error: unknown): string {
  if (error instanceof AssetError) {
    if (error.code === "ASSET_TOO_LARGE") return "larger than 8 MB";
    return error.message;
  }
  throw error;
}

/**
 * The slide's images that are missing now, written with exclusive create (US-16, D19). A name
 * taken by a different file moves to `-2`, `-3`… and the reference is rewritten; a file with the
 * same bytes is reused, never copied. Symlinks, submodules and images over 8 MB are skipped.
 */
async function planImages(
  deck: DeckEntry,
  copy: VersionCopy,
  presentation: Presentation,
  index: number,
): Promise<ImagePlan> {
  const plan: ImagePlan = { changes: [], renames: new Map(), restoredAssets: [], skippedAssets: [] };
  const root = journalRoot(deck);
  const planned = new Set<string>();
  const references = new Set(
    (await assetReferences(presentation))
      .filter((reference) => reference.index === index && ASSET_REF.test(reference.path))
      .map((reference) => reference.path),
  );
  for (const reference of [...references].sort()) {
    const name = reference.slice("assets/".length);
    const skipped = copy.skipped.find((item) => item.path === reference);
    if (skipped) {
      plan.skippedAssets.push({ path: reference, reason: skipped.reason });
      continue;
    }
    const now = await onDisk(path.join(root, reference));
    const version = await onDisk(path.join(copy.root, "assets", name));
    if (version.kind !== "file") {
      if (now.kind === "missing") plan.skippedAssets.push({ path: reference, reason: "not in that version" });
      continue;
    }
    if (now.kind === "file" && now.bytes.equals(version.bytes)) continue; // Already there.
    if (!journalCovers(deck, reference)) {
      plan.skippedAssets.push({ path: reference, reason: "hidden file" });
      continue;
    }
    try {
      checkAsset(name, version.bytes);
    } catch (error) {
      plan.skippedAssets.push({ path: reference, reason: skipReason(error) });
      continue;
    }
    if (now.kind === "missing" && !planned.has(reference)) {
      plan.changes.push({ path: reference, before: null, after: version.bytes });
      plan.restoredAssets.push({ from: reference, to: reference });
      planned.add(reference);
      continue;
    }
    for (const candidate of candidates(name)) {
      const target = `assets/${candidate}`;
      if (planned.has(target)) continue;
      const there = await onDisk(path.join(root, target));
      if (there.kind === "file" && there.bytes.equals(version.bytes)) {
        plan.renames.set(name, candidate); // Same bytes under another name: reuse it.
        break;
      }
      if (there.kind !== "missing") continue;
      plan.changes.push({ path: target, before: null, after: version.bytes });
      plan.restoredAssets.push({ from: reference, to: target });
      plan.renames.set(name, candidate);
      planned.add(target);
      break;
    }
  }
  return plan;
}

// ---------- the service ----------

export interface SlideRestoreResult {
  /** The restored slide's ID in the deck now. */
  slideId: string;
  restoredAssets: RestoredAsset[];
  skippedAssets: Skipped[];
}

async function loadCopy(copy: VersionCopy): Promise<Presentation> {
  try {
    return (await loadPresentation(copy.deckPath, { blueprint: "evaluate" })).presentation;
  } catch (error) {
    throw new StudioError(
      422,
      "DECK_LOAD_FAILED",
      `That version of the deck doesn't load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const readOrNull = (file: string) => fs.readFile(file).catch(() => null);

/** A folder deck's slide file, which must stay inside the deck and be part of its undo history. */
function checkSource(deck: DeckEntry, source: string): void {
  if (!journalCovers(deck, source) || path.isAbsolute(source))
    throw new StudioError(422, "VALIDATION_FAILED", "That slide's file is outside the deck.", {
      path: source,
    });
}

export class VersionSlides {
  constructor(
    private readonly deps: {
      versions: DeckHistoryService;
      journal: DeckJournal;
      copies: VersionCopies;
    },
  ) {}

  /** GET …/versions/:sha: the version's slides, each `same`, `changed` or `gone` against the deck now. */
  async view(deck: DeckEntry, sha: string): Promise<{ version: Version; slides: VersionSlide[] }> {
    const copy = await this.deps.copies.copy(deck, sha);
    const version = await this.deps.versions.version(deck, sha);
    const presentation = await loadCopy(copy);
    const root = journalRoot(deck);
    const missingImages = new Set<number>();
    for (const reference of await assetReferences(presentation)) {
      if (reference.index === null || !ASSET_REF.test(reference.path)) continue;
      const inVersion = await onDisk(path.join(copy.root, reference.path));
      if (inVersion.kind === "file" && (await onDisk(path.join(root, reference.path))).kind === "missing")
        missingImages.add(reference.index);
    }

    let status: (index: number) => Promise<VersionSlide["status"]>;
    if (deck.kind === "folder") {
      const manifest = await fs
        .readFile(path.join(deck.absolute, "presentation.yml"), "utf8")
        .catch(() => "");
      const current = new Set(manifestSources(manifest));
      status = async (index) => {
        const source = presentation.slides[index]!.source;
        if (!current.has(source)) return "gone";
        const [then, now] = [
          await readOrNull(path.join(copy.root, source)),
          await readOrNull(path.join(root, source)),
        ];
        return then && now && then.equals(now) ? "same" : "changed";
      };
    } else {
      const then = chunkLayout(await fs.readFile(copy.deckPath, "utf8")).cores;
      const now = chunkLayout((await readOrNull(deck.absolute))?.toString("utf8") ?? "").cores;
      status = async (index) =>
        index >= now.length ? "gone" : then[index] === now[index] ? "same" : "changed";
    }

    const slides: VersionSlide[] = [];
    for (const [index, slide] of presentation.slides.entries()) {
      let mark = await status(index);
      if (mark === "same" && missingImages.has(index)) mark = "changed";
      slides.push({
        slideId: slideIdAt(deck, presentation, index),
        index,
        title: slide.title,
        template: slide.template,
        status: mark,
      });
    }
    return { version, slides };
  }

  /** GET …/versions/:sha/slides/:slideId/preview: the version's slide as a standalone document. */
  async preview(deck: DeckEntry, deckId: string, sha: string, slideId: string): Promise<string> {
    const copy = await this.deps.copies.copy(deck, sha);
    const presentation = await loadCopy(copy);
    const index = slideIndex(deck, presentation, slideId);
    try {
      return await renderSlideDocument(presentation, index, {
        assetBase: `/api/decks/${deckId}/versions/${sha}/files/`,
      });
    } catch (error) {
      if (error instanceof ValidationError)
        throw new StudioError(422, "RENDER_FAILED", error.message, {
          details: { field: error.field ?? null },
        });
      throw error;
    }
  }

  /**
   * POST …/versions/:sha/slides/:slideId/restore. A folder deck matches the slide by file name; a
   * single-file deck by position. A slide that's gone goes back at min(oldIndex, slideCount). No
   * DECK_DIRTY check: only this slide, the manifest entry it needs and its missing images change.
   */
  restore(deck: DeckEntry, sha: string, slideId: string): Promise<SlideRestoreResult> {
    checkSha(sha);
    return this.deps.journal.apply(deck, async () => {
      const copy = await this.deps.copies.copy(deck, sha);
      const presentation = await loadCopy(copy);
      const index = slideIndex(deck, presentation, slideId);
      const slide = presentation.slides[index]!;
      const images = await planImages(deck, copy, presentation, index);
      const rewrite = (text: string) =>
        [...images.renames].reduce((out, [from, to]) => rewriteImage(out, from, to), text);
      const root = journalRoot(deck);
      const changes: FileChange[] = [...images.changes];
      let restoredId: string;

      if (deck.kind === "folder") {
        const source = slide.source;
        checkSource(deck, source);
        const versionBytes = await fs.readFile(path.join(copy.root, source));
        const after = images.renames.size
          ? Buffer.from(rewrite(versionBytes.toString("utf8")), "utf8")
          : versionBytes;
        const before = await readOrNull(path.join(root, source));
        if (!before || !before.equals(after)) changes.push({ path: source, before, after });
        const manifest = await fs.readFile(path.join(root, "presentation.yml"));
        const sources = manifestSources(manifest.toString("utf8"));
        if (!sources.includes(source)) {
          const at = Math.min(index, sources.length);
          const text = insertManifestEntry(manifest.toString("utf8"), source, at);
          changes.push({ path: "presentation.yml", before: manifest, after: Buffer.from(text, "utf8") });
        }
        restoredId = source;
      } else {
        const name = path.basename(deck.absolute);
        const core = chunkLayout(await fs.readFile(copy.deckPath, "utf8")).cores[index];
        if (core === undefined)
          throw new StudioError(404, "SLIDE_NOT_FOUND", "No slide with that ID in this version.", {
            path: slideId,
          });
        const before = await fs.readFile(deck.absolute);
        const placed = placeChunk(before.toString("utf8"), index, rewrite(core));
        const after = Buffer.from(placed.text, "utf8");
        if (!before.equals(after)) changes.push({ path: name, before, after });
        restoredId = `#${placed.index}`;
      }

      return {
        label: `Restore slide "${slide.title || "Untitled"}"`,
        changes,
        result: {
          slideId: restoredId,
          restoredAssets: images.restoredAssets,
          skippedAssets: images.skippedAssets,
        },
      };
    });
  }
}
