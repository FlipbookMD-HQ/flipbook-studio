import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { AssetError, checkAsset, imageSize, sourceToSlides, ValidationError } from "@flipbook-md/core";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Dropped, SourceDocument } from "../shared/api.js";
import { StudioError } from "./errors.js";
import { TMP_DIR } from "./workspace.js";

// US-18: read an uploaded .md, .txt or .docx into Markdown plus images (D22), and keep it in
// `.flipbook-studio-tmp/sources/<id>/` until an import or a generation uses it (D24).

export const ZIP_MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 2000;
export const SOURCE_MAX_IMAGES = 50;
export const SOURCE_TTL_MS = 30 * 60 * 1000;
const THUMBNAIL_MAX_BYTES = 256 * 1024;
const DROPPED_SRC = "about:flipbook-dropped";

export interface SourceImage {
  /** The href the Markdown uses: "image1.png". */
  fileName: string;
  bytes: Buffer;
}

export interface ReadSource {
  format: "md" | "txt" | "docx";
  markdown: string;
  /** The document's own title (a docx's core properties), if any. */
  title: string | null;
  images: SourceImage[];
  dropped: Dropped[];
}

function addDropped(list: Dropped[], entry: Omit<Dropped, "count">, count = 1) {
  const found = list.find(
    (item) => item.kind === entry.kind && item.reason === entry.reason && item.detail === entry.detail,
  );
  if (found) found.count += count;
  else list.push({ ...entry, count });
}

const tooLarge = () => new StudioError(413, "SOURCE_TOO_LARGE", "This document is too large to open safely.");
const unreadable = () =>
  new StudioError(
    422,
    "SOURCE_UNREADABLE",
    "This Word file can't be opened. Remove its password or save it again as .docx.",
  );
const notDocx = () => new StudioError(415, "SOURCE_TYPE", "Pick a Markdown, text or Word (.docx) file.");

// ---------- zip guard (D22) ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/**
 * Reads the zip's central directory without inflating anything, and refuses a file whose entries
 * would expand past 100 MB, that has more than 2,000 entries, uses ZIP64, or encrypts entries.
 */
export function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) throw unreadable(); // OLE: encrypted or .doc
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw notDocx();
  let eocd = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at -= 1) {
    if (buf.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw unreadable();
  const total = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff || size === 0xffffffff) throw tooLarge();
  if (total > ZIP_MAX_ENTRIES) throw tooLarge();
  if (offset + size > buf.length) throw unreadable();
  const entries = new Map<string, ZipEntry>();
  let expanded = 0;
  let at = offset;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw unreadable();
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressedSize = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    if (flags & 0x1) throw unreadable();
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) throw tooLarge();
    expanded += uncompressedSize;
    if (expanded > ZIP_MAX_EXPANDED_BYTES) throw tooLarge();
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated with a cap at its declared size; null when it can't be read. */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8)
      return inflateRawSync(data, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  } catch {
    return null;
  }
  return null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function docxTitle(buf: Buffer, entries: Map<string, ZipEntry>): string | null {
  const entry = entries.get("docProps/core.xml");
  if (!entry) return null;
  const xml = readZipEntry(buf, entry)?.toString("utf8") ?? "";
  const match = /<dc:title>([^<]*)<\/dc:title>/.exec(xml);
  const title = match ? decodeXml(match[1]!).trim() : "";
  return title || null;
}

// ---------- readers ----------

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function extensionFor(contentType: string): string {
  const known = IMAGE_EXTENSIONS[contentType.toLowerCase()];
  if (known) return known;
  const sub = contentType.split("/")[1] ?? "bin";
  return (
    sub
      .replace(/^x-/, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase() || "bin"
  );
}

/** Mammoth writes table rows as <td> only; GFM tables need a header row, and no <p> inside cells. */
function tableHtmlForMarkdown(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (table) => {
    let first = true;
    const cleaned = table
      .replace(/<\/p>\s*<p>/g, " ")
      .replace(/<\/?p>/g, "")
      .replace(/<tr>([\s\S]*?)<\/tr>/g, (row, cells: string) => {
        if (!first) return row;
        first = false;
        return `<tr>${cells.replace(/<td\b/g, "<th").replace(/<\/td>/g, "</th>")}</tr>`;
      });
    return cleaned;
  });
}

function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  service.use(gfm);
  return service;
}

/** A .docx: headings, lists, emphasis and tables to Markdown; embedded images collected (D22). */
export async function readDocx(buf: Buffer): Promise<ReadSource> {
  const entries = zipEntries(buf);
  if (!entries.has("word/document.xml")) throw notDocx();
  const dropped: Dropped[] = [];
  const images: SourceImage[] = [];
  let seen = 0;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: buf },
      {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async (image) => {
          seen += 1;
          let bytes: Buffer;
          try {
            bytes = await image.read();
          } catch {
            addDropped(dropped, { kind: "linked-image", reason: "not-embedded" });
            return { src: DROPPED_SRC };
          }
          if (images.length >= SOURCE_MAX_IMAGES) {
            addDropped(dropped, { kind: "image", reason: "limit" });
            return { src: DROPPED_SRC };
          }
          const fileName = `image${seen}.${extensionFor(image.contentType)}`;
          images.push({ fileName, bytes });
          return { src: fileName };
        }),
      },
    );
    html = result.value;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw unreadable();
  }
  const markdown = turndown()
    .turndown(tableHtmlForMarkdown(html))
    .replace(/!\[[^\]]*\]\(about:flipbook-dropped\)/g, "")
    // Turndown pads list markers ("-   item"); one space reads like hand-written Markdown.
    .replace(/^(\s*)(-|\d+\.)\s{2,}(?=\S)/gm, "$1$2 ");
  return { format: "docx", markdown, title: docxTitle(buf, entries), images, dropped };
}

/** A .md or .txt: strict UTF-8, BOM removed. */
export function readText(buf: Buffer, format: "md" | "txt"): ReadSource {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new StudioError(
      422,
      "SOURCE_ENCODING",
      "This file isn't UTF-8 text. Save it as UTF-8 and try again.",
    );
  }
  // A UTF-16 file decodes as UTF-8 only when it is nothing but NULs and ASCII; refuse it too.
  if (text.includes("\u0000")) {
    throw new StudioError(
      422,
      "SOURCE_ENCODING",
      "This file isn't UTF-8 text. Save it as UTF-8 and try again.",
    );
  }
  return { format, markdown: text.replace(/^\uFEFF/, ""), title: null, images: [], dropped: [] };
}

export function sourceFormat(fileName: string): "md" | "txt" | "docx" {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".docx") return "docx";
  throw new StudioError(415, "SOURCE_TYPE", "Pick a Markdown, text or Word (.docx) file.");
}

export async function readSource(fileName: string, buf: Buffer): Promise<ReadSource> {
  const format = sourceFormat(fileName);
  return format === "docx" ? readDocx(buf) : readText(buf, format);
}

// ---------- the store ----------

interface StoredMeta {
  document: SourceDocument;
  markdown: string;
  images: string[];
}

export interface LoadedSource {
  document: SourceDocument;
  markdown: string;
  images: SourceImage[];
}

const ID = /^[0-9a-f-]{36}$/;
const expired = () =>
  new StudioError(404, "SOURCE_EXPIRED", "That file is no longer available. Pick it again.");

/** Sources live on disk under the D17 temp folder, so a restart (which empties it) forgets them. */
export class SourceStore {
  constructor(private readonly now: () => number = Date.now) {}

  private dir(root: string, id?: string) {
    const base = path.join(root, TMP_DIR, "sources");
    return id ? path.join(base, id) : base;
  }

  /** POST /api/sources: reads the file, checks its images like uploads, and stores it. */
  async save(root: string, fileName: string, buf: Buffer): Promise<SourceDocument> {
    await this.sweep(root);
    if (!buf.length || !buf.toString("utf8", 0, Math.min(buf.length, 4096)).trim()) {
      if (sourceFormat(fileName) !== "docx")
        throw new StudioError(422, "VALIDATION_FAILED", "This file is empty.", {
          details: { field: "file" },
        });
    }
    const read = await readSource(fileName, buf);
    const dropped = [...read.dropped];
    const kept: SourceImage[] = [];
    const imageMap: Record<string, string | null> = {};
    for (const image of read.images) {
      try {
        checkAsset(image.fileName, image.bytes);
        kept.push(image);
        imageMap[image.fileName] = image.fileName;
      } catch (error) {
        if (!(error instanceof AssetError)) throw error;
        imageMap[image.fileName] = null;
        addDropped(dropped, {
          kind: "image",
          reason: error.code === "ASSET_TOO_LARGE" ? "size" : "type",
          detail: path.extname(image.fileName).slice(1).toUpperCase(),
        });
      }
    }
    const fallback = read.title ?? path.basename(fileName, path.extname(fileName));
    let mapped;
    try {
      mapped = sourceToSlides(read.markdown, { title: fallback, images: imageMap });
    } catch (error) {
      if (error instanceof ValidationError)
        throw new StudioError(422, "VALIDATION_FAILED", "This file is empty.", {
          details: { field: "file" },
        });
      throw error;
    }
    for (const entry of mapped.dropped) addDropped(dropped, entry, entry.count);

    const id = randomUUID();
    const document: SourceDocument = {
      sourceId: id,
      fileName: path.basename(fileName),
      format: read.format,
      title: mapped.title,
      chars: mapped.chars,
      sections: mapped.sections,
      images: kept.map((image) => {
        const ext = path.extname(image.fileName).toLowerCase();
        const size = imageSize(ext, image.bytes);
        const mime = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
        }[ext];
        return {
          id: image.fileName,
          name: image.fileName,
          bytes: image.bytes.length,
          width: size?.width ?? null,
          height: size?.height ?? null,
          thumbnail:
            mime && image.bytes.length <= THUMBNAIL_MAX_BYTES
              ? `data:${mime};base64,${image.bytes.toString("base64")}`
              : null,
        };
      }),
      dropped,
      expiresAt: new Date(this.now() + SOURCE_TTL_MS).toISOString(),
    };
    // Images that failed the check are dropped from the text, so the deck never points at them.
    const markdown = Object.entries(imageMap)
      .reduce(
        (text, [href, kept]) => (kept ? text : text.split(`](${href})`).join("](about:flipbook-dropped)")),
        read.markdown,
      )
      .replace(/!\[[^\]]*\]\(about:flipbook-dropped\)/g, "");

    const dir = this.dir(root, id);
    await fs.mkdir(path.join(dir, "images"), { recursive: true });
    for (const image of kept) await fs.writeFile(path.join(dir, "images", image.fileName), image.bytes);
    const meta: StoredMeta = { document, markdown, images: kept.map((image) => image.fileName) };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
    return document;
  }

  /** The stored source, or 404 SOURCE_EXPIRED for an unknown, used or expired ID. */
  async get(root: string, id: string): Promise<LoadedSource> {
    if (!ID.test(id)) throw expired();
    const dir = this.dir(root, id);
    const raw = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
    if (!raw) throw expired();
    const meta = JSON.parse(raw) as StoredMeta;
    if (Date.parse(meta.document.expiresAt) <= this.now()) {
      await this.consume(root, id);
      throw expired();
    }
    const images = await Promise.all(
      meta.images.map(async (fileName) => ({
        fileName,
        bytes: await fs.readFile(path.join(dir, "images", fileName)),
      })),
    );
    return { document: meta.document, markdown: meta.markdown, images };
  }

  async consume(root: string, id: string): Promise<void> {
    if (!ID.test(id)) return;
    await fs.rm(this.dir(root, id), { recursive: true, force: true });
  }

  /** Deletes expired sources. */
  async sweep(root: string): Promise<void> {
    const entries = await fs.readdir(this.dir(root)).catch(() => [] as string[]);
    for (const id of entries) {
      const dir = this.dir(root, id);
      const raw = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
      // A folder with no meta.json yet may be a save in progress: only an old one is removed.
      const expiresAt = raw
        ? Date.parse((JSON.parse(raw) as StoredMeta).document.expiresAt)
        : ((await fs.stat(dir).catch(() => null))?.mtimeMs ?? 0) + SOURCE_TTL_MS;
      if (expiresAt <= this.now()) await this.consume(root, id);
    }
  }
}
