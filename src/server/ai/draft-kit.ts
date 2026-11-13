import fs from "node:fs/promises";
import path from "node:path";
import { isAlias, parse as parseYaml, parseDocument, stringify, visit } from "yaml";
import { z } from "zod";
import {
  ReservedNameError,
  TEMPLATES,
  ValidationError,
  libraryRoot,
  normalizeBlueprint,
  normalizeGroup,
  parsePlacement,
  resolveKitPath,
  themeLibraryDirs,
} from "@flipbook-md/core";
import { cssWarning } from "../../shared/cssTokens.js";
import type { DraftKitRequest, KitKind, LlmSettings, Proposal, ProposalOp } from "../../shared/api.js";
import { findDeck, loadDeck } from "../decks.js";
import { StudioError } from "../errors.js";
import { coreRef } from "../kits.js";
import type { LlmProvider } from "../llm/provider.js";
import { scanLibrary } from "../workspace.js";
import {
  DRAFT_KIT_JSON_SCHEMAS,
  THEME_TOKENS,
  draftKitMessages,
  type DraftKitContext,
} from "./prompts/draft-kit.js";
import { kitKey, type ProposalStore } from "./proposals.js";
import type { SseContext } from "./sse.js";
import { OutputProblem, structuredCall } from "./structured.js";

/** A drafted kit file is at most 50 kB (data model invariant; hostile YAML guard). */
export const KIT_FILE_LIMIT = 50 * 1024;
const REFERENCE_THEME = "marvel-jarvis";
const THEME_NAME = /^[a-z0-9-]{1,60}$/;
const YAML_OPTIONS = { aliasDuplicateObjects: false, lineWidth: 0 } as const;

// Loose shapes: core's normalizers do the real validation and their messages go back to the model.
const Mapping = z.record(z.unknown());
const BlueprintOutput = z.object({ types: Mapping, pages: z.array(z.unknown()).min(1) }).passthrough();
const KIT_OUTPUTS = {
  theme: z.object({ css: z.string().trim().min(1, "css is empty") }),
  template: Mapping,
  blueprint: BlueprintOutput,
  group: z
    .object({
      description: z.string().max(500).optional(),
      canvas: z.string().optional(),
      themes: z
        .array(
          z.union([
            z.string(),
            z.object({ name: z.string(), draft: z.string().trim().min(1).max(2000) }).strict(),
          ]),
        )
        .min(1)
        .max(8),
      style: z.string(),
      chrome: z.unknown().optional(),
      templates: Mapping,
      blueprint: BlueprintOutput,
    })
    .passthrough(),
} satisfies Record<KitKind, z.ZodTypeAny>;
export type KitOutput<K extends KitKind> = z.infer<(typeof KIT_OUTPUTS)[K]>;

/** What validation needs to know, gathered before the stream opens (validation itself never reads disk). */
export interface DraftKnowledge {
  /** Theme names that exist (library and built-in). */
  themes: Set<string>;
  /** Template names a blueprint may use besides core's built-ins. */
  templates: Set<string>;
}

export interface DraftedSources {
  /** The files to write, the requested kit first. */
  files: { kind: KitKind; name: string; source: string }[];
  /** Themes a group drafted by description: each still needs its CSS. */
  themesToDraft: { name: string; description: string }[];
}

class DraftInvalid extends Error {}

const sizeCheck = (source: string, label: string) => {
  if (Buffer.byteLength(source, "utf8") > KIT_FILE_LIMIT)
    throw new DraftInvalid(`${label} is over 50 kB. Make it shorter.`);
  return source;
};

/**
 * Reads a model reply as JSON, or as YAML without anchors or aliases (a model sometimes answers
 * in YAML). Over 50 kB, invalid, or using anchors/aliases: an OutputProblem for the retry.
 */
export function readKitReply(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    if (Buffer.byteLength(body, "utf8") > KIT_FILE_LIMIT)
      throw new OutputProblem("The answer is over 50 kB. Make it shorter.");
    const doc = parseDocument(body, { prettyErrors: false });
    if (doc.errors.length)
      throw new OutputProblem(
        `The answer wasn't valid JSON or YAML (${doc.errors[0]!.message.split("\n")[0]}).`,
      );
    let anchored = false;
    visit(doc, (_key, node) => {
      if (isAlias(node) || (node && typeof node === "object" && "anchor" in node && node.anchor))
        anchored = true;
    });
    if (anchored) throw new OutputProblem("YAML anchors and aliases aren't allowed. Write every value out.");
    return doc.toJS({ maxAliasCount: 0 });
  }
}

function themeProblem(css: string): string | null {
  const warning = cssWarning(css);
  if (warning) return `The CSS doesn't parse: ${warning}`;
  if (/@import/i.test(css)) return "@import isn't allowed.";
  if (/url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(css) && !/url\(\s*["']?\s*data:image\//i.test(css))
    return "Remote url() values aren't allowed.";
  if (/<\/?\s*(style|script)/i.test(css) || /expression\s*\(|javascript:/i.test(css))
    return "HTML and script aren't allowed in CSS.";
  const missing = Object.keys(THEME_TOKENS).filter((token) => !new RegExp(`${token}\\s*:`).test(css));
  if (missing.length) return `The theme must set ${missing.join(", ")}.`;
  return null;
}

const blueprintTemplates = (names: Iterable<string>) =>
  Object.fromEntries([...names].map((name) => [name, true]));

function placementOf(name: string, value: unknown) {
  try {
    const placement = parsePlacement(name, value);
    // Only the fields the file keeps, in the editor's order.
    return Object.fromEntries(
      (["column", "row", "width", "height", "align", "role", "layout", "density"] as const)
        .filter((key) => placement[key] != null)
        .map((key) => [key, placement[key]]),
    );
  } catch (error) {
    throw new DraftInvalid((error as Error).message.replace(/^templates\.yml /, ""));
  }
}

function blueprintOf(value: KitOutput<"blueprint">, templates: Record<string, unknown>, where = "") {
  const plain = { pages: value.pages, types: value.types };
  try {
    normalizeBlueprint(plain, templates as never);
  } catch (error) {
    throw new DraftInvalid(`${where}${(error as Error).message}`);
  }
  return plain;
}

/**
 * Turns a model's structured draft into kit source text: YAML serialized by Studio (or the CSS
 * as given), validated with core's normalizers. Pure: it never reads or writes the disk.
 * Throws DraftInvalid with a message the model can act on.
 */
export function kitDraftToSources<K extends KitKind>(
  kind: K,
  name: string,
  output: KitOutput<K>,
  knowledge: DraftKnowledge,
): DraftedSources {
  if (kind === "theme") {
    const css = sizeCheck(`${(output as KitOutput<"theme">).css.trim()}\n`, "The theme");
    const problem = themeProblem(css);
    if (problem) throw new DraftInvalid(problem);
    return { files: [{ kind, name, source: css }], themesToDraft: [] };
  }
  if (kind === "template") {
    const source = stringify(placementOf(name, output), YAML_OPTIONS);
    return { files: [{ kind, name, source: sizeCheck(source, "The template") }], themesToDraft: [] };
  }
  if (kind === "blueprint") {
    const plain = blueprintOf(output as KitOutput<"blueprint">, blueprintTemplates(knowledge.templates));
    return {
      files: [{ kind, name, source: sizeCheck(stringify(plain, YAML_OPTIONS), "The blueprint") }],
      themesToDraft: [],
    };
  }

  const group = output as KitOutput<"group">;
  // Template names are forced to <group>_…; blueprint rules follow the rename.
  const prefix = `${name}_`;
  const renamed = new Map<string, string>();
  const templates: Record<string, unknown> = {};
  for (const [raw, value] of Object.entries(group.templates)) {
    const key = raw.trim().toLowerCase();
    const forced = key.startsWith(prefix) ? key : `${prefix}${key.replace(/[^a-z0-9_-]/g, "-")}`;
    renamed.set(raw, forced);
    renamed.set(key, forced);
    templates[forced] = placementOf(forced, value);
  }
  const types = Object.fromEntries(
    Object.entries(group.blueprint.types).map(([type, rules]) => {
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) return [type, rules];
      const template = (rules as { template?: unknown }).template;
      return [
        type,
        typeof template === "string" && renamed.has(template)
          ? { ...rules, template: renamed.get(template) }
          : rules,
      ];
    }),
  );
  const blueprint = blueprintOf({ ...group.blueprint, types }, templates, "blueprint: ");

  const themes: string[] = [];
  const themesToDraft: DraftedSources["themesToDraft"] = [];
  for (const theme of group.themes) {
    const themeName = (typeof theme === "string" ? theme : theme.name).trim();
    if (!THEME_NAME.test(themeName))
      throw new DraftInvalid(
        `"${themeName}" is not a valid theme name. Use lowercase letters, digits and -.`,
      );
    if (themes.includes(themeName)) continue;
    if (typeof theme === "string") {
      if (!knowledge.themes.has(themeName))
        throw new DraftInvalid(
          `Theme "${themeName}" doesn't exist. Use an existing theme or draft it as {"name": "${themeName}", "draft": "<what it looks like>"}.`,
        );
    } else {
      if (knowledge.themes.has(themeName))
        throw new DraftInvalid(
          `Theme "${themeName}" already exists. List it by name, or give the new theme another name.`,
        );
      themesToDraft.push({ name: themeName, description: theme.draft });
    }
    themes.push(themeName);
  }
  const style = group.style.trim();
  const file: Record<string, unknown> = {
    name,
    description: (group.description ?? "").trim(),
    style,
    canvas: group.canvas?.trim() || "midnight",
    themes,
    ...(group.chrome != null ? { chrome: group.chrome } : {}),
    templates,
    blueprint,
  };
  try {
    normalizeGroup(file, name);
  } catch (error) {
    throw new DraftInvalid((error as Error).message.replace(`Template group "${name}" `, "The media kit "));
  }
  return {
    files: [{ kind, name, source: sizeCheck(stringify(file, YAML_OPTIONS), "The media kit") }],
    themesToDraft,
  };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

const DECK_NAMES: Partial<Record<KitKind, string>> = { theme: "presentation", blueprint: "blueprint" };

/** Checks run before the stream opens: the name is valid and free, and what validation will need. */
export async function prepareDraftKit(root: string, library: string, request: DraftKitRequest) {
  const { kind } = request;
  if (request.deckId && !DECK_NAMES[kind]) {
    throw new StudioError(422, "VALIDATION_FAILED", `Draft a ${kind} for the library.`, {
      details: { field: "deckId" },
    });
  }
  const scope = request.deckId ? ("deck" as const) : ("library" as const);
  const name = scope === "deck" ? DECK_NAMES[kind]! : request.name;
  let file: string;
  try {
    file = resolveKitPath(await coreRef(root, kind, name, scope, request.deckId));
  } catch (error) {
    if (error instanceof ReservedNameError)
      throw new StudioError(422, "RESERVED_NAME", error.message, { details: { field: "name" } });
    if (error instanceof ValidationError)
      throw new StudioError(422, "VALIDATION_FAILED", error.message, { details: { field: "name" } });
    throw error;
  }
  // Templates and media kits share templates/<name>.yml, so either kind takes the name.
  if (await exists(file)) {
    throw new StudioError(
      409,
      "KIT_EXISTS",
      scope === "deck"
        ? `This deck already has ${path.basename(file)}.`
        : `A ${kind} named "${name}" already exists. Pick another name.`,
      { details: { field: "name" } },
    );
  }

  const scanned = await scanLibrary(library);
  const themes = new Set(scanned.themes.map((theme) => theme.name));
  for (const dir of themeLibraryDirs())
    for (const entry of await fs.readdir(dir).catch(() => [] as string[]))
      if (entry.endsWith(".css")) themes.add(entry.slice(0, -4));
  const templates = new Set<string>();
  if (scope === "deck") {
    const { presentation } = await loadDeck(await findDeck(root, request.deckId!));
    for (const template of Object.keys(presentation.templates ?? {})) templates.add(template);
  } else {
    for (const template of scanned.templates) if (!(template.name in TEMPLATES)) templates.add(template.name);
    for (const group of scanned.groups) {
      // A group's templates can be used by name in a library blueprint.
      const dir = group.scope === "builtin" ? libraryRoot() : library;
      try {
        const parsed = parseYaml(await fs.readFile(path.join(dir, "templates", `${group.name}.yml`), "utf8"));
        for (const template of Object.keys(parsed?.templates ?? {})) templates.add(template);
      } catch {
        // A broken group adds no templates.
      }
    }
  }
  const referenceCss = await fs
    .readFile(path.join(libraryRoot(), "themes", `${REFERENCE_THEME}.css`), "utf8")
    .catch(() => "");
  return { kind, scope, name, deckId: request.deckId, knowledge: { themes, templates }, referenceCss };
}

export type PreparedDraft = Awaited<ReturnType<typeof prepareDraftKit>>;

/** POST /api/ai/draft-kit: streams tokens, then one proposal of writeKitFile ops (nothing is written). */
export async function runDraftKit(
  context: SseContext,
  prepared: PreparedDraft,
  request: DraftKitRequest,
  deps: {
    provider: LlmProvider;
    llm: LlmSettings & { model: string };
    store: ProposalStore;
    log?: (line: string) => void;
  },
) {
  const draft = async <K extends KitKind>(kind: K, name: string, description: string) => {
    let sources: DraftedSources | null = null;
    const promptContext: DraftKitContext = {
      kind,
      name,
      description,
      referenceCss: prepared.referenceCss,
      themes: [...prepared.knowledge.themes].sort(),
      templates: ["flow", "cover", "summary", ...[...prepared.knowledge.templates].sort()],
    };
    await structuredCall({
      provider: deps.provider,
      model: deps.llm.model,
      messages: draftKitMessages(promptContext),
      schema: KIT_OUTPUTS[kind] as z.ZodType<KitOutput<K>>,
      jsonSchema: DRAFT_KIT_JSON_SCHEMAS[kind],
      temperature: deps.llm.temperature,
      signal: context.signal,
      parse: readKitReply,
      accept: (value) => {
        try {
          sources = kitDraftToSources(kind, name, value, prepared.knowledge);
          return null;
        } catch (error) {
          if (error instanceof DraftInvalid) return `The draft isn't valid: ${error.message}`;
          throw error;
        }
      },
      onToken: (text) => context.send("token", { text }),
      log: deps.log,
    });
    return sources! as DraftedSources;
  };

  const main = await draft(prepared.kind, prepared.name, request.description);
  const files = [...main.files];
  for (const theme of main.themesToDraft) {
    context.send("notice", { message: `Drafting theme ${theme.name}` });
    const drafted = await draft(
      "theme",
      theme.name,
      `${theme.description}\n(For the media kit "${prepared.name}": ${request.description})`,
    );
    files.push(...drafted.files);
  }

  const ops: ProposalOp[] = files.map((file, index) => ({
    id: `op-${index + 1}`,
    kind: "writeKitFile",
    kit: {
      kind: file.kind,
      name: file.name,
      scope: file === files[0] ? prepared.scope : "library",
      ...(file === files[0] && prepared.deckId ? { deckId: prepared.deckId } : {}),
    },
    source: file.source,
  }));
  const proposal: Proposal = deps.store.add({
    deckId: prepared.deckId ?? null,
    summary:
      ops.length > 1
        ? `Draft ${prepared.kind} "${prepared.name}" with ${ops.length - 1} new theme${ops.length > 2 ? "s" : ""}`
        : `Draft ${prepared.kind} "${prepared.name}"`,
    ops,
    baseHashes: Object.fromEntries(
      ops.map((op) => [kitKey((op as Extract<ProposalOp, { kind: "writeKitFile" }>).kit), null]),
    ),
  });
  context.send("proposal", proposal);
  return {};
}
