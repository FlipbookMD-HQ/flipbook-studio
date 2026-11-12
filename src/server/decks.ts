import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PRESETS, discoverPresentation, renderExportDocument, type Presentation } from "@flipbook-md/core";
import type { DeckDetail, SlideDoc } from "../shared/api.js";
import { StudioError } from "./errors.js";
import { decodeDeckId, resolveInside } from "./paths.js";
import { findDecks, loadError, type DeckEntry } from "./workspace.js";

const SHADOW_SCRIPT =
  /<script>document\.getElementById\("canvas"\)\.attachShadow\(\{mode:"open"\}\)\.innerHTML=(".*?");<\/script>/s;

/**
 * Core's export document fills its canvas with a script. Preview iframes run with no
 * `allow-scripts`, so the payload moves into a declarative shadow root instead.
 * Replaced by core's renderSlideDocument in US-3.
 */
export function scriptFree(documentHtml: string): string {
  const match = SHADOW_SCRIPT.exec(documentHtml);
  if (!match?.[1]) return documentHtml.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const payload = JSON.parse(match[1]) as string;
  return documentHtml
    .replace(match[0], "")
    .replace(
      '<div id="canvas" class="canvas"></div>',
      `<div id="canvas" class="canvas"><template shadowrootmode="open">${payload}</template></div>`,
    );
}

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

async function hashFile(file: string): Promise<string> {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** sha256 of every file the deck reads, keyed by its path inside the deck. */
async function deckHashes(deck: DeckEntry, presentation: Presentation): Promise<Record<string, string>> {
  if (deck.kind === "single") return { [path.basename(deck.absolute)]: await hashFile(deck.absolute) };
  const files = ["presentation.yml", ...presentation.slides.map((slide) => slide.source)];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = await hashFile(path.join(deck.absolute, file));
  return hashes;
}

export async function deckDetail(root: string, id: string): Promise<DeckDetail> {
  const deck = await findDeck(root, id);
  const presentation = await loadDeck(deck);
  const preset = PRESETS.instagram;
  const slides: SlideDoc[] = await Promise.all(
    presentation.slides.map(async (slide, index) => ({
      id: deck.kind === "folder" ? slide.source : `#${index}`,
      index,
      title: slide.title,
      template: slide.template,
      type: slide.type ?? null,
      html: scriptFree(await renderExportDocument(presentation, slide, index, preset)),
    })),
  );
  return {
    id,
    path: deck.relative,
    kind: deck.kind,
    title: presentation.title,
    theme: presentation.theme,
    group: presentation.group ?? null,
    style: presentation.style ?? null,
    slides,
    hashes: await deckHashes(deck, presentation),
  };
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
