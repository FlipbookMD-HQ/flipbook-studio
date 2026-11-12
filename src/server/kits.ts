import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BuiltInReadOnlyError,
  FileConflictError,
  KitExistsError,
  KitInvalidError,
  KitNotFoundError,
  ReservedNameError,
  ValidationError,
  libraryRoot,
  evaluateDraftBlueprint,
  parseKit,
  parsePlacement,
  TEMPLATES,
  flipbookHome,
  loadPresentation,
  readKit,
  renderSampleDocument,
  copyGroup as coreCopyGroup,
  findDecksUsingGroup,
  renameGroup as coreRenameGroup,
  writeKit,
  type KitRef as CoreKitRef,
} from "@flipbook-md/core";
import type {
  CreateKitRequest,
  KitDoc,
  KitKind,
  KitPreviewResponse,
  KitScope,
  UpdateKitRequest,
} from "../shared/api.js";
import { findDeck, loadDeck } from "./decks.js";
import { StudioError } from "./errors.js";
import { encodeDeckId } from "./paths.js";
import { findDecks, type DeckEntry } from "./workspace.js";

const DECK_FILES: Partial<Record<KitKind, string>> = {
  theme: "presentation.css",
  template: "templates.yml",
  blueprint: "blueprint.yml",
};

/** Deck-scope kit files sit next to presentation.yml, so only folder decks have them. */
async function deckDir(root: string, kind: KitKind, deckId: string | undefined): Promise<DeckEntry> {
  if (!deckId)
    throw new StudioError(422, "VALIDATION_FAILED", "Deck scope needs a deckId.", {
      details: { field: "deckId" },
    });
  const deck = await findDeck(root, deckId);
  if (deck.kind !== "folder") {
    throw new StudioError(422, "VALIDATION_FAILED", "Only folder decks have their own kit files.", {
      details: { field: "deckId" },
    });
  }
  if (!DECK_FILES[kind])
    throw new StudioError(422, "VALIDATION_FAILED", `A ${kind} has no deck scope.`, {
      details: { field: "scope" },
    });
  return deck;
}

/** The core ref for a Studio kit ref (deck scope resolved to the deck's folder). */
export async function coreRef(
  root: string,
  kind: KitKind,
  name: string,
  scope: KitScope,
  deckId?: string,
): Promise<CoreKitRef> {
  if (scope !== "deck") return { kind, name, scope };
  const deck = await deckDir(root, kind, deckId);
  // A deck's templates.yml holds many templates; its ref names one of them (templates.yml#<name>).
  const refName = kind === "template" ? name : DECK_FILES[kind]!.replace(/\.\w+$/, "");
  return { kind, name: refName, scope, deckDir: deck.absolute };
}

/** Maps core kit errors to the API's error catalog. */
function kitFailure(error: unknown, label: string): never {
  if (error instanceof StudioError) throw error;
  if (error instanceof KitNotFoundError) throw new StudioError(404, "KIT_NOT_FOUND", `No ${label}.`);
  if (error instanceof KitExistsError)
    throw new StudioError(409, "KIT_EXISTS", `${label} already exists. Pick another name.`);
  if (error instanceof KitInvalidError) throw new StudioError(422, "KIT_INVALID", error.message);
  if (error instanceof ReservedNameError)
    throw new StudioError(422, "RESERVED_NAME", error.message, { details: { field: "name" } });
  if (error instanceof BuiltInReadOnlyError)
    throw new StudioError(403, "BUILT_IN_READONLY", `${label} is built in and read-only. Save it as a copy.`);
  if (error instanceof FileConflictError) {
    throw new StudioError(409, "FILE_CONFLICT", `${label} changed on disk since you opened it.`, {
      details: { currentHash: error.currentHash },
    });
  }
  if (error instanceof ValidationError) {
    throw new StudioError(422, "VALIDATION_FAILED", error.message, {
      details: { field: error.field ?? null },
    });
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOSPC" || code === "EROFS") {
    throw new StudioError(500, "WRITE_FAILED", `Could not write ${label}: ${code}.`);
  }
  throw error;
}

/** Workspace decks that use a kit: by `style` (theme), `group`, a slide's template, or deck scope. */
async function usedBy(
  root: string,
  kind: KitKind,
  name: string,
  scope: KitScope,
  deckId?: string,
): Promise<string[]> {
  if (scope === "deck") return deckId ? [deckId] : [];
  if (kind === "blueprint") return []; // Library blueprints are copied into groups, never referenced (D10).
  const users: string[] = [];
  for (const deck of await findDecks(root)) {
    try {
      const { presentation } = await loadPresentation(deck.absolute);
      const deckUses =
        (kind === "theme" && presentation.style === name) ||
        (kind === "group" && presentation.group === name) ||
        (kind === "template" && presentation.slides.some((slide) => slide.template === name));
      if (deckUses) users.push(encodeDeckId(deck.relative));
    } catch {
      // A deck that doesn't load uses nothing we can see.
    }
  }
  return users;
}

async function doc(
  root: string,
  kind: KitKind,
  name: string,
  scope: KitScope,
  deckId?: string,
): Promise<KitDoc> {
  const ref = await coreRef(root, kind, name, scope, deckId);
  let read;
  try {
    read = await readKit(ref);
  } catch (error) {
    kitFailure(error, scope === "deck" ? `${DECK_FILES[kind]} in this deck` : `${kind} "${name}"`);
  }
  return {
    ref: { kind, name: ref.name, scope, ...(deckId && scope === "deck" ? { deckId } : {}) },
    source: read.source,
    parsed: kind === "theme" ? null : (read.parsed ?? null),
    hash: read.hash,
    builtIn: read.builtIn,
    invalid: read.invalid,
    usedBy: await usedBy(root, kind, ref.name, scope, deckId),
  };
}

export function parseKind(kind: string): KitKind {
  if (kind === "theme" || kind === "template" || kind === "blueprint" || kind === "group") return kind;
  throw new StudioError(404, "NOT_FOUND", "No such API route.");
}

/** GET /api/kits/:kind/:name */
export const getKit = (root: string, kind: KitKind, name: string, scope: KitScope, deckId?: string) =>
  doc(root, kind, name, scope, deckId);

/** POST /api/kits/:kind: creates a kit (409 KIT_EXISTS when the name is taken). */
export async function createKit(root: string, kind: KitKind, request: CreateKitRequest): Promise<KitDoc> {
  const ref = await coreRef(root, kind, request.name, request.scope, request.deckId);
  try {
    await writeKit(ref, { source: request.source }, null);
  } catch (error) {
    kitFailure(error, request.scope === "deck" ? DECK_FILES[kind]! : `A ${kind} named "${request.name}"`);
  }
  return doc(root, kind, request.name, request.scope, request.deckId);
}

/** PUT /api/kits/:kind/:name: hash-checked update. `patch` arrives with US-8. */
export async function updateKit(
  root: string,
  kind: KitKind,
  name: string,
  request: UpdateKitRequest,
): Promise<KitDoc> {
  const hasSource = request.source != null;
  if (hasSource === (request.patch !== undefined)) {
    throw new StudioError(422, "VALIDATION_FAILED", "Send either source or patch.", {
      details: { field: "patch" },
    });
  }
  if (request.baseHash === null && !(kind === "template" && request.scope === "deck" && !hasSource)) {
    throw new StudioError(422, "VALIDATION_FAILED", "baseHash is required.", {
      details: { field: "baseHash" },
    });
  }
  const ref = await coreRef(root, kind, name, request.scope, request.deckId);
  try {
    const change = hasSource ? { source: request.source! } : { patch: request.patch ?? null };
    await writeKit(ref, change, request.baseHash);
  } catch (error) {
    kitFailure(error, request.scope === "deck" ? DECK_FILES[kind]! : `${kind} "${name}"`);
  }
  return doc(root, kind, name, request.scope, request.deckId);
}

/** POST /api/kits/:kind/preview: themes render the sample deck, or a deck's first slides. */
export async function previewKit(
  root: string,
  kind: KitKind,
  request: { source: string; deckId?: string; scope?: "library" | "builtin"; name?: string },
): Promise<KitPreviewResponse> {
  if (kind === "template") return previewTemplate(root, request);
  if (kind === "blueprint") return previewBlueprint(root, request);
  if (kind === "group") return previewGroup(request);
  if (kind !== "theme") {
    throw new StudioError(422, "VALIDATION_FAILED", `Previewing a ${kind} isn't available yet.`, {
      details: { field: "kind" },
    });
  }
  if (request.deckId) {
    const { presentation } = await loadDeck(await findDeck(root, request.deckId));
    return { html: await renderSampleDocument({ themeCss: request.source, presentation }), errors: [] };
  }
  const assetRoot = path.join(request.scope === "builtin" ? libraryRoot() : flipbookHome(), "themes");
  return { html: await renderSampleDocument({ themeCss: request.source, assetRoot }), errors: [] };
}

/** The CSS of a theme by name and the folder its url()s resolve in: the library's, else the built-in. */
async function namedTheme(name: string): Promise<{ css: string; assetRoot: string } | null> {
  for (const scope of ["library", "builtin"] as const) {
    try {
      const theme = await readKit({ kind: "theme", name, scope });
      return { css: theme.source, assetRoot: path.dirname(theme.path) };
    } catch {
      // Not in this scope, or not a valid name.
    }
  }
  return null;
}

/** A group preview: one sample slide per blueprint page step, in the group's style theme. */
async function previewGroup(request: { source: string; name?: string }): Promise<KitPreviewResponse> {
  let parsed: unknown;
  try {
    parsed = parseYaml(request.source);
  } catch (error) {
    return { html: "", errors: [`Not valid YAML: ${(error as Error).message.split("\n")[0]}`] };
  }
  const group = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const theme = typeof group.style === "string" ? await namedTheme(group.style) : null;
  const errors = theme || typeof group.style !== "string" ? [] : [`Theme "${group.style}" was not found.`];
  try {
    const html = await renderSampleDocument({
      group: parsed,
      themeCss: theme?.css ?? "",
      ...(theme ? { assetRoot: theme.assetRoot } : {}),
    });
    return { html, errors };
  } catch (error) {
    return { html: "", errors: [(error as Error).message, ...errors] };
  }
}

/** POST /api/kits/group/:name/copy: copies a built-in or library group into the library. */
export async function copyGroup(
  root: string,
  name: string,
  request: { toName: string; scope?: "library" | "builtin" },
): Promise<KitDoc> {
  let scope = request.scope;
  if (!scope) {
    scope = "builtin";
    try {
      await readKit({ kind: "group", name, scope: "library" });
      scope = "library";
    } catch {
      // Not in the library: copy the built-in.
    }
  }
  try {
    await coreCopyGroup({ name, scope }, request.toName);
  } catch (error) {
    kitFailure(
      error,
      error instanceof KitNotFoundError ? `media kit "${name}"` : `A media kit named "${request.toName}"`,
    );
  }
  return doc(root, "group", request.toName, "library");
}

/** POST /api/kits/group/:name/rename: renames a library group and lists the decks still on the old name. */
export async function renameGroup(
  root: string,
  name: string,
  request: { toName: string; baseHash: string },
): Promise<{ kit: KitDoc; decksUsingOldName: string[] }> {
  try {
    await coreRenameGroup({ name, scope: "library" }, request.toName, request.baseHash);
  } catch (error) {
    if (error instanceof KitNotFoundError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      // Only built-ins are left: they are read-only.
      try {
        await readKit({ kind: "group", name, scope: "builtin" });
      } catch {
        throw new StudioError(404, "KIT_NOT_FOUND", `No media kit "${name}".`);
      }
      kitFailure(new BuiltInReadOnlyError(name), `media kit "${name}"`);
    }
    kitFailure(
      error,
      error instanceof KitExistsError ? `A media kit named "${request.toName}"` : `media kit "${name}"`,
    );
  }
  const decks = await findDecks(root);
  const using = new Set(
    await findDecksUsingGroup(
      name,
      decks.map((deck) => deck.absolute),
    ),
  );
  return {
    kit: await doc(root, "group", request.toName, "library"),
    decksUsingOldName: decks
      .filter((deck) => using.has(deck.absolute))
      .map((deck) => encodeDeckId(deck.relative)),
  };
}

/**
 * A blueprint preview: with deckId, the deck's slides that would fail (`affectedSlides`);
 * without, only whether the blueprint is valid against the library's templates.
 */
async function previewBlueprint(
  root: string,
  request: { source: string; deckId?: string },
): Promise<KitPreviewResponse> {
  if (request.deckId) {
    const { presentation } = await loadDeck(await findDeck(root, request.deckId));
    const result = evaluateDraftBlueprint(presentation, request.source);
    return result.errors
      ? { html: "", errors: result.errors }
      : { html: "", errors: [], affectedSlides: result.violations };
  }
  try {
    await parseKit({ kind: "blueprint", name: "draft", scope: "library" }, request.source);
    return { html: "", errors: [] };
  } catch (error) {
    return { html: "", errors: [(error as Error).message] };
  }
}

const TEMPLATE_SAMPLE =
  "# Placed here\n\nSample content shows where this template puts a slide's text.\n\n- First point\n- Second point";

/** A template preview: one sample slide placed in the region, in the deck's theme when deckId is given. */
async function previewTemplate(
  root: string,
  request: { source: string; deckId?: string; name?: string },
): Promise<KitPreviewResponse> {
  const name =
    request.name && /^[a-z][a-z0-9_-]*$/.test(request.name) && !(request.name in TEMPLATES)
      ? request.name
      : "preview";
  let placement;
  try {
    placement = parsePlacement(name, parseYaml(request.source));
  } catch (error) {
    return { html: "", errors: [(error as Error).message] };
  }
  const deck = request.deckId ? (await loadDeck(await findDeck(root, request.deckId))).presentation : null;
  const html = await renderSampleDocument({
    themeCss: deck?.themeCss ?? "",
    canvas: deck?.theme ?? "midnight",
    templates: { ...(deck?.templates ?? {}), [name]: placement },
    slides: [{ role: name, template: name, markdown: TEMPLATE_SAMPLE }],
    ...(deck ? { assetRoot: deck.root } : {}),
  });
  return { html, errors: [] };
}

/** Which deck-scope kit files a folder deck has. */
export async function deckKits(deck: DeckEntry): Promise<("theme" | "template" | "blueprint")[]> {
  if (deck.kind !== "folder") return [];
  const found: ("theme" | "template" | "blueprint")[] = [];
  for (const kind of ["theme", "template", "blueprint"] as const) {
    const stat = await fs.stat(path.join(deck.absolute, DECK_FILES[kind]!)).catch(() => null);
    if (stat?.isFile()) found.push(kind);
  }
  return found;
}
