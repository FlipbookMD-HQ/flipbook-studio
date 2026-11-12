import { Document, isMap, isScalar, parseDocument } from "yaml";
import { asBlueprint, blueprintProblems, type Blueprint, type Problem } from "./blueprintModel";
import { RESERVED_TEMPLATES, regionProblem, type Region } from "./templateFields";

export const CANVASES = ["midnight", "light", "paper", "forest"] as const;
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const COUNTER_LINES = ["solid", "dashed", "dotted"] as const;
export const LINE_ALIGNS = ["top", "middle", "bottom"] as const;
export const BAND_LINES = ["straight", "dashed", "dotted"] as const;
export const SHAPES = [
  "circle",
  "triangle",
  "square",
  "pentagram",
  "hexagram",
  "heptagram",
  "octagram",
  "nonagram",
] as const;
export const GROUP_NAME = /^[a-z][a-z0-9_-]{0,59}$/;

export interface Counter {
  corner: string;
  line: string;
  line_align: string;
  line_length: string;
  ornament?: string;
}
export interface Band {
  kind: "line" | "shapes" | "none";
  line?: string;
  shape?: string;
}
export interface GroupTemplate extends Region {
  align?: string;
  role?: string;
  layout?: string;
  [key: string]: unknown;
}
/** A media kit as its YAML parses: the editor's value. */
export interface Group {
  name: string;
  description?: string;
  style: string;
  canvas?: string;
  themes: string[];
  chrome?: { counter: Counter; header?: Band; footer?: Band };
  templates: Record<string, GroupTemplate>;
  blueprint: Blueprint;
  [key: string]: unknown;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The editor's value from parsed YAML (missing parts filled), or null when it isn't a mapping. */
export function asGroup(parsed: unknown): Group | null {
  if (!plain(parsed)) return null;
  return {
    ...parsed,
    name: String(parsed.name ?? ""),
    style: String(parsed.style ?? ""),
    themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
    templates: plain(parsed.templates) ? (parsed.templates as Record<string, GroupTemplate>) : {},
    blueprint: asBlueprint(parsed.blueprint) ?? { pages: [], types: {} },
  } as Group;
}

/** Template names a kit's blueprint may use: the built-ins and the kit's own. */
export const blueprintTemplates = (group: Group) => [...RESERVED_TEMPLATES, ...Object.keys(group.templates)];

/** Problems shown inline before saving, with `where` as section ids. */
export function groupProblems(group: Group): Problem[] {
  const problems: Problem[] = [];
  if (!GROUP_NAME.test(group.name))
    problems.push({
      where: "overview",
      message: "Name the kit with lowercase letters, digits, - or _ (start with a letter).",
    });
  if (!group.themes.length) problems.push({ where: "themes", message: "Pick at least one theme." });
  if (!group.themes.includes(group.style))
    problems.push({ where: "themes", message: `The style must be one of the selected themes.` });
  const counter = group.chrome?.counter;
  if (counter && !/^\d+(\.\d+)?(%|px)$/.test(String(counter.line_length ?? "")))
    problems.push({
      where: "chrome",
      message: "Line length must be a percent or px value, such as 40% or 240px.",
    });
  const ornament = String(counter?.ornament ?? "").trim();
  if (
    ornament &&
    !/^https:\/\//i.test(ornament) &&
    !/^[a-zA-Z0-9._/-]+\.(?:gif|png|jpe?g|svg|webp|avif)$/.test(ornament) &&
    (ornament.length > 4 || /[<>&"'`]/.test(ornament))
  )
    problems.push({
      where: "chrome",
      message: "The ornament must be a short glyph (up to 4 characters) or an image path.",
    });
  for (const [name, template] of Object.entries(group.templates)) {
    const where = `templates.${name}`;
    if (!name.startsWith(`${group.name}_`))
      problems.push({ where, message: `"${name}" must start with ${group.name}_.` });
    const region = regionProblem(template);
    if (region) problems.push({ where, message: region });
  }
  for (const problem of blueprintProblems(group.blueprint, new Set(blueprintTemplates(group))))
    problems.push({ ...problem, where: `blueprint.${problem.where}` });
  return problems;
}

/** A new kit's starting point: a cover template, a cover and 1–5 points, a counter at bottom right. */
export function starterGroup(name: string, style = "marvel-jarvis"): Group {
  return {
    name,
    description: "",
    style,
    canvas: "midnight",
    themes: [style],
    chrome: { counter: { corner: "bottom-right", line: "solid", line_align: "middle", line_length: "40%" } },
    templates: {
      [`${name}_cover`]: {
        column: 1,
        row: 1,
        width: 3,
        height: 3,
        align: "center",
        role: "cover",
        layout: "poster",
      },
    },
    blueprint: {
      pages: [{ type: "cover" }, { type: "point", repeat: { min: 1, max: 5 } }],
      types: { cover: { template: `${name}_cover` }, point: {} },
    },
  };
}

export const groupYaml = (group: Group) =>
  new Document(group).toString({ flowCollectionPadding: false, lineWidth: 0 });

/**
 * The kit's source under a new name: `name`, `<from>_` template keys and blueprint template
 * references. The same rewrite core's copyGroup and renameGroup do, so comments and order stay.
 */
export function renamedGroupSource(source: string, from: string, to: string): string {
  const doc = parseDocument(source);
  const prefix = `${from}_`;
  const swap = (value: unknown) =>
    typeof value === "string" && value.startsWith(prefix) ? `${to}_${value.slice(prefix.length)}` : value;
  const name = doc.get("name", true);
  if (isScalar(name)) name.value = to;
  else doc.set("name", to);
  const templates = doc.get("templates", true);
  if (isMap(templates))
    for (const pair of templates.items) if (isScalar(pair.key)) pair.key.value = swap(pair.key.value);
  const types = doc.getIn(["blueprint", "types"], true);
  if (isMap(types)) {
    for (const pair of types.items) {
      const template = isMap(pair.value) ? pair.value.get("template", true) : null;
      if (isScalar(template)) template.value = swap(template.value);
    }
  }
  return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

/**
 * A library blueprint copied into a kit (D10): template names that match one of the kit's own
 * templates without its prefix are remapped to it (`quote` → `<kit>_quote`).
 */
export function remapBlueprint(blueprint: Blueprint, group: Group): Blueprint {
  const own = new Set(Object.keys(group.templates));
  const types = Object.fromEntries(
    Object.entries(blueprint.types).map(([type, rules]) => {
      const template = rules?.template;
      const prefixed = template ? `${group.name}_${template}` : null;
      return [
        type,
        prefixed && !own.has(template!) && own.has(prefixed) ? { ...rules, template: prefixed } : rules,
      ];
    }),
  );
  return { ...blueprint, types };
}
