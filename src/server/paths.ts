import fs from "node:fs/promises";
import path from "node:path";
import { StudioError } from "./errors.js";

function outside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function refuse(relative: string): never {
  throw new StudioError(403, "PATH_OUTSIDE_ROOT", "File is outside the workspace.", { path: relative });
}

/**
 * Resolves `relative` (already percent-decoded once by the router) inside `root`.
 * Rejects absolute paths, NUL bytes, `..` escapes and symlinks whose real path leaves the root.
 * Returns the real absolute path. Missing files keep their lexical path so callers can 404.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  if (relative.includes("\0") || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) refuse(relative);
  const realRoot = await fs.realpath(root);
  const lexical = path.resolve(realRoot, relative);
  if (outside(realRoot, lexical)) refuse(relative);
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return lexical;
    throw error;
  }
  if (outside(realRoot, real)) refuse(relative);
  return real;
}

/** Deck IDs are base64url of the workspace-relative path (data-model: DeckId). */
export function encodeDeckId(relative: string): string {
  return Buffer.from(relative, "utf8").toString("base64url");
}

export function decodeDeckId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new StudioError(404, "DECK_NOT_FOUND", "No deck with that ID.");
  const relative = Buffer.from(id, "base64url").toString("utf8");
  if (!relative || encodeDeckId(relative) !== id)
    throw new StudioError(404, "DECK_NOT_FOUND", "No deck with that ID.");
  return relative;
}

/**
 * Resolves a folder Studio will create (an export output) inside `root`. Unlike `resolveInside`,
 * the deepest existing ancestor is resolved too, so a symlinked parent can't point outside.
 */
export async function resolveOutputDir(root: string, relative: string): Promise<string> {
  const lexical = await resolveInside(root, relative);
  const realRoot = await fs.realpath(root);
  let existing = lexical;
  const rest: string[] = [];
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const target = path.join(existing, ...rest);
  if (outside(realRoot, target) || target === realRoot) refuse(relative);
  return target;
}
