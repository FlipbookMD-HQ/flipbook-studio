import fs from "node:fs/promises";
import path from "node:path";
import {
  AssetError,
  assetsDir,
  ValidationError,
  assetReferences,
  listDeckAssets,
  loadPresentation,
  removeDeckAsset,
  writeDeckAsset,
} from "@flipbook-md/core";
import type { AssetUse, DeckAsset } from "../shared/api.js";
import { findDeck, slideIdAt } from "./decks.js";
import { StudioError } from "./errors.js";
import { encodeDeckId } from "./paths.js";
import { findDecks, type DeckEntry } from "./workspace.js";

// US-16: deck images (tech-spec D18-D20). Core checks, names and writes; this maps its errors
// and works out which slides use each image.

const WRITE_ERRORS = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EISDIR", "EBUSY"]);

function assetFailure(error: unknown, where: string): never {
  if (error instanceof AssetError) {
    const status = {
      ASSET_TYPE: 415,
      ASSET_TOO_LARGE: 413,
      ASSET_CONTENT_MISMATCH: 422,
      ASSET_NOT_FOUND: 404,
    }[error.code] as 415 | 413 | 422 | 404;
    throw new StudioError(status, error.code, error.message, { path: where });
  }
  if (error instanceof ValidationError) {
    if (error.code === "PATH_OUTSIDE_ROOT")
      throw new StudioError(403, "PATH_OUTSIDE_ROOT", "File is outside the workspace.", { path: where });
    throw new StudioError(422, "VALIDATION_FAILED", error.message, { path: where });
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code && WRITE_ERRORS.has(code))
    throw new StudioError(500, "WRITE_FAILED", `Could not write ${where}: ${code}.`, { path: where });
  throw error;
}

/**
 * The decks whose images live in the same folder as this deck's: a folder deck alone, or every
 * top-level single-file deck (they share the workspace's `assets/`, D18).
 */
async function sharingDecks(root: string, deck: DeckEntry): Promise<DeckEntry[]> {
  if (deck.kind === "folder") return [deck];
  const singles = (await findDecks(root)).filter((entry) => entry.kind === "single");
  return [deck, ...singles.filter((entry) => entry.relative !== deck.relative)];
}

/** Image path → the slides (or deck themes) that use it. A deck that fails to load adds nothing. */
async function usages(root: string, deck: DeckEntry): Promise<Map<string, AssetUse[]>> {
  const uses = new Map<string, AssetUse[]>();
  for (const entry of await sharingDecks(root, deck)) {
    let presentation;
    try {
      ({ presentation } = await loadPresentation(entry.absolute, { blueprint: "evaluate" }));
    } catch {
      continue;
    }
    const prefix = entry.relative === deck.relative ? "" : `${entry.relative} · `;
    for (const reference of await assetReferences(presentation)) {
      const slide = reference.index === null ? null : presentation.slides[reference.index];
      const use: AssetUse = {
        deckId: encodeDeckId(entry.relative),
        deckPath: entry.relative,
        slideId: slide ? slideIdAt(entry, presentation, reference.index!) : null,
        label: slide ? `${prefix}${reference.index! + 1}. ${slide.title || "Untitled"}` : `${prefix}Theme`,
      };
      uses.set(reference.path, [...(uses.get(reference.path) ?? []), use]);
    }
  }
  return uses;
}

async function listWithUses(root: string, deck: DeckEntry): Promise<DeckAsset[]> {
  let files;
  try {
    files = await listDeckAssets(deck.absolute);
  } catch (error) {
    assetFailure(error, "assets");
  }
  if (files.length === 0) return [];
  const uses = await usages(root, deck);
  return files.map((file) => ({ ...file, usedBy: uses.get(file.path) ?? [] }));
}

/** GET /api/decks/:id/assets */
export async function deckAssets(root: string, id: string): Promise<{ assets: DeckAsset[] }> {
  return { assets: await listWithUses(root, await findDeck(root, id)) };
}

/** POST /api/decks/:id/assets: stores the upload under a new name; never overwrites. */
export async function uploadAsset(root: string, id: string, file: unknown): Promise<{ asset: DeckAsset }> {
  const deck = await findDeck(root, id);
  if (!(file instanceof File)) {
    throw new StudioError(422, "VALIDATION_FAILED", "Send the image as a multipart field named file.", {
      details: { field: "file" },
    });
  }
  let written;
  try {
    written = await writeDeckAsset(deck.absolute, file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    assetFailure(error, file.name);
  }
  const listed = (await listDeckAssets(deck.absolute)).find((entry) => entry.path === written.path);
  const asset = listed ?? {
    path: written.path,
    bytes: written.bytes,
    mime: file.type,
    width: null,
    height: null,
  };
  return { asset: { ...asset, usedBy: [] } };
}

/** DELETE /api/decks/:id/assets/*: 409 ASSET_IN_USE with the slides that use it, unless forced. */
export async function deleteAsset(
  root: string,
  id: string,
  assetPath: string,
  force: boolean,
): Promise<void> {
  const deck = await findDeck(root, id);
  // Only an image that exists can be in use; otherwise removeDeckAsset gives the right error.
  const exists = await fs
    .lstat(path.join(path.dirname(await assetsDir(deck.absolute)), assetPath))
    .then(() => true)
    .catch(() => false);
  if (!force && exists) {
    const usedBy = (await usages(root, deck)).get(assetPath) ?? [];
    if (usedBy.length) {
      throw new StudioError(409, "ASSET_IN_USE", `${assetPath} is used by ${usedBy.length} slide(s).`, {
        path: assetPath,
        details: { usedBy },
      });
    }
  }
  try {
    await removeDeckAsset(deck.absolute, assetPath);
  } catch (error) {
    assetFailure(error, assetPath);
  }
}
