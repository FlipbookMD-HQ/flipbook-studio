import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TEMPLATES, discoverPresentation, templateLibraryDirs, themeLibraryDirs } from "@flipbook-md/core";
import type { ApiError, DeckSummary, KitRef, Workspace } from "../shared/api.js";
import { encodeDeckId } from "./paths.js";

export const TMP_DIR = ".flipbook-studio-tmp";

export interface DeckEntry {
  relative: string;
  absolute: string;
  kind: "folder" | "single";
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Top-level decks only: `*.slide.md` files and folders holding `presentation.yml`. */
export async function findDecks(root: string): Promise<DeckEntry[]> {
  const realRoot = await fs.realpath(root);
  const entries = await fs.readdir(realRoot, { withFileTypes: true });
  const decks: DeckEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === TMP_DIR) continue;
    const absolute = path.join(realRoot, entry.name);
    let real: string;
    let stat;
    try {
      real = await fs.realpath(absolute);
      stat = await fs.stat(real);
    } catch {
      continue; // Broken symlink.
    }
    if (!inside(realRoot, real)) continue; // Symlink that leaves the workspace.
    if (stat.isFile() && entry.name.endsWith(".slide.md")) {
      decks.push({ relative: entry.name, absolute: real, kind: "single" });
    } else if (stat.isDirectory()) {
      const manifest = await fs.stat(path.join(real, "presentation.yml")).catch(() => null);
      if (manifest?.isFile()) decks.push({ relative: entry.name, absolute: real, kind: "folder" });
    }
  }
  return decks.sort((a, b) => a.relative.localeCompare(b.relative));
}

export function loadError(error: unknown, relative: string): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  const violations = (error as { violations?: unknown }).violations;
  return {
    code: "DECK_LOAD_FAILED",
    message,
    path: relative,
    ...(Array.isArray(violations) ? { details: { violations } } : {}),
  };
}

export async function summarize(deck: DeckEntry): Promise<DeckSummary> {
  const base = { id: encodeDeckId(deck.relative), path: deck.relative, kind: deck.kind };
  try {
    const presentation = await discoverPresentation(deck.absolute);
    return {
      ...base,
      title: presentation.title,
      slideCount: presentation.slides.length,
      group: presentation.group ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      title: deck.relative,
      slideCount: 0,
      group: null,
      error: loadError(error, deck.relative),
    };
  }
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name.slice(0, -extension.length))
    .sort();
}

/** The first library dir is the user's library; the last is core's built-in one. */
function scopeOf(dir: string, dirs: string[]): KitRef["scope"] {
  return dirs.length > 1 && dir === dirs[dirs.length - 1] ? "builtin" : "library";
}

function unique(refs: KitRef[]): KitRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.name)) return false; // The user's library shadows a built-in of the same name.
    seen.add(ref.name);
    return true;
  });
}

/** A group (media kit) file has `templates` and `blueprint` keys. Returns its description, or null if it isn't a group. */
async function groupDescription(file: string): Promise<string | null> {
  try {
    const parsed = parseYaml(await fs.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("templates" in parsed) || !("blueprint" in parsed))
      return null;
    return typeof parsed.description === "string" ? parsed.description.trim() : "";
  } catch {
    return null;
  }
}

export async function scanLibrary(library: string): Promise<Workspace["library"]> {
  const themeDirs = themeLibraryDirs();
  const themes = unique(
    (
      await Promise.all(
        themeDirs.map(async (dir) =>
          (await listFiles(dir, ".css")).map((name) => ({
            kind: "theme" as const,
            name,
            scope: scopeOf(dir, themeDirs),
          })),
        ),
      )
    ).flat(),
  );

  const templateDirs = templateLibraryDirs();
  const groups: KitRef[] = [];
  const templates: KitRef[] = Object.keys(TEMPLATES).map((name) => ({
    kind: "template",
    name,
    scope: "builtin",
  }));
  for (const dir of templateDirs) {
    for (const name of await listFiles(dir, ".yml")) {
      const scope = scopeOf(dir, templateDirs);
      const description = await groupDescription(path.join(dir, `${name}.yml`));
      if (description == null) templates.push({ kind: "template", name, scope });
      else groups.push({ kind: "group", name, scope, ...(description ? { description } : {}) });
    }
  }

  const blueprints = (await listFiles(path.join(library, "blueprints"), ".yml")).map((name) => ({
    kind: "blueprint" as const,
    name,
    scope: "library" as const,
  }));
  return { themes, templates: unique(templates), blueprints, groups: unique(groups) };
}

export async function scanWorkspace(root: string, library: string): Promise<Workspace> {
  const decks = await Promise.all((await findDecks(root)).map(summarize));
  return { root, decks, library: await scanLibrary(library) };
}
