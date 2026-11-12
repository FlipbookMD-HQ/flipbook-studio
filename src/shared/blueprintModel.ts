import { Document, isMap, isScalar, parseDocument } from "yaml";

/** Content kinds a rule can require, allow or forbid (core's list). */
export const CONTENT_KINDS = [
  "heading",
  "paragraph",
  "list",
  "code",
  "image",
  "blockquote",
  "table",
] as const;
export const TYPE_NAME = /^[a-z][a-z0-9-]*$/;

export interface Rules {
  template?: string | null;
  max_chars?: number;
  max_items?: number;
  require?: string[];
  allow?: string[];
  forbid?: string[];
}
export interface Step extends Omit<Rules, "template"> {
  type?: string;
  any?: string[];
  repeat?: number | { min?: number; max: number };
}
/** A blueprint as its YAML parses: the editor's value. */
export interface Blueprint {
  pages: Step[];
  types: Record<string, Rules>;
}
export interface Problem {
  /** Where: "types.<name>", "pages.<n>" (1-based) or "blueprint". */
  where: string;
  message: string;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The editor's value from parsed YAML, or null when it isn't a blueprint-shaped mapping. */
export function asBlueprint(parsed: unknown): Blueprint | null {
  if (!plain(parsed)) return null;
  return {
    ...parsed,
    pages: Array.isArray(parsed.pages) ? (parsed.pages as Step[]) : [],
    types: plain(parsed.types) ? (parsed.types as Record<string, Rules>) : {},
  } as Blueprint;
}

/** `repeat` as min and max (1 and 1 when unset, like core). */
export function repeatOf(step: Step): { min: number; max: number } {
  const value = step.repeat;
  if (value == null) return { min: 1, max: 1 };
  if (typeof value === "number") return { min: value, max: value };
  return { min: value.min ?? 0, max: value.max };
}

/** Problems shown inline before saving. `templates` are the names the blueprint may use. */
export function blueprintProblems(blueprint: Blueprint, templates: Set<string>): Problem[] {
  const problems: Problem[] = [];
  if (!blueprint.pages.length) problems.push({ where: "blueprint", message: "Add at least one page step." });
  for (const [name, rules] of Object.entries(blueprint.types)) {
    const where = `types.${name}`;
    if (!TYPE_NAME.test(name))
      problems.push({
        where,
        message: `"${name}" is not a valid type name (lowercase letters, digits and -).`,
      });
    if (rules?.template && !templates.has(rules.template))
      problems.push({ where, message: `Unknown template "${rules.template}".` });
  }
  blueprint.pages.forEach((step, index) => {
    const where = `pages.${index + 1}`;
    const names = step.any ?? (step.type ? [step.type] : []);
    if (!names.length) problems.push({ where, message: "Pick a page type." });
    for (const name of names)
      if (!(name in blueprint.types)) problems.push({ where, message: `Type "${name}" is not defined.` });
    const { min, max } = repeatOf(step);
    if (!Number.isInteger(min) || min < 0) problems.push({ where, message: "Repeat min must be 0 or more." });
    if (!Number.isInteger(max) || max < min)
      problems.push({ where, message: "Repeat max can't be below min." });
  });
  return problems;
}

/** Renames a type, keeping its place among the types and updating every page that names it. */
export function renameType(blueprint: Blueprint, from: string, to: string): Blueprint {
  if (from === to || to in blueprint.types) return blueprint;
  const types = Object.fromEntries(
    Object.entries(blueprint.types).map(([name, rules]) => [name === from ? to : name, rules]),
  );
  const pages = blueprint.pages.map((step) => ({
    ...step,
    ...(step.type === from ? { type: to } : {}),
    ...(step.any ? { any: step.any.map((name) => (name === from ? to : name)) } : {}),
  }));
  return { ...blueprint, types, pages };
}

/** The RFC 7386 merge patch that turns `before` into `after` (arrays are replaced whole). */
export function mergeDiff(before: unknown, after: unknown): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const a = plain(before) ? before : {};
  const b = plain(after) ? after : {};
  for (const key of Object.keys(a)) if (!(key in b)) patch[key] = null;
  for (const [key, value] of Object.entries(b)) {
    const old = a[key];
    if (plain(old) && plain(value)) {
      const nested = mergeDiff(old, value);
      if (Object.keys(nested).length) patch[key] = nested;
    } else if (JSON.stringify(old) !== JSON.stringify(value)) {
      patch[key] = value;
    }
  }
  return patch;
}

const OUTPUT = { flowCollectionPadding: false, lineWidth: 0 } as const;

function applyTo(doc: Document, at: string[], patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    const where = [...at, key];
    if (value === null) {
      doc.deleteIn(where);
      continue;
    }
    const node = doc.getIn(where, true);
    if (plain(value) && isMap(node)) applyTo(doc, where, value);
    else if (isScalar(node) && (value === null || typeof value !== "object")) node.value = value;
    else doc.setIn(where, doc.createNode(value));
  }
}

/**
 * Applies a merge patch to YAML text exactly as core's writeKit does, so the raw tab shows what
 * saving the form will write: comments, key order and quoting survive.
 */
export function patchYaml(source: string, patch: Record<string, unknown>): string {
  const doc = parseDocument(source);
  if (doc.contents == null) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  applyTo(doc, [], patch);
  return doc.toString(OUTPUT);
}

/** YAML text for a new blueprint. */
export function blueprintYaml(blueprint: Blueprint): string {
  return new Document(blueprint).toString(OUTPUT);
}

export const STARTER: Blueprint = {
  pages: [{ type: "cover" }, { type: "point", repeat: { min: 1, max: 5 } }],
  types: { cover: { template: "cover" }, point: {} },
};
