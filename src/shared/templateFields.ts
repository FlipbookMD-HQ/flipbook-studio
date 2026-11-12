/** A template's region on the 3×3 grid, in grid cells (1-based column and row). */
export interface Region {
  column: number;
  row: number;
  width: number;
  height: number;
}
export type Align = "start" | "center" | "end";
export const ROLES = ["cover", "toc", "topics", "media", "quote", "callout", "timeline", "content"] as const;
export const LAYOUTS = [
  "poster",
  "list",
  "topics",
  "media",
  "quote",
  "callout",
  "timeline",
  "content",
] as const;
export const RESERVED_TEMPLATES = ["flow", "cover", "summary"];

export interface TemplateFields extends Region {
  align: Align;
  role: string | null;
  layout: string | null;
}

/** Why a region can't be saved, or null. Matches core's parsePlacement rules. */
export function regionProblem(region: Region): string | null {
  const values = [region.column, region.row, region.width, region.height];
  if (values.some((value) => !Number.isInteger(value)))
    return "Column, row, width and height must be whole numbers.";
  if (values.some((value) => value < 1)) return "Column, row, width and height start at 1.";
  if (region.column + region.width > 4) return "The region spills past the grid's right edge.";
  if (region.row + region.height > 4) return "The region spills past the grid's bottom edge.";
  return null;
}

/** Why a template name can't be used, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return "Name the template.";
  if (RESERVED_TEMPLATES.includes(name)) return `"${name}" is a built-in template. Pick another name.`;
  if (!/^[a-z][a-z0-9_-]{0,59}$/.test(name))
    return "Start with a letter; use lowercase letters, digits, - or _.";
  return null;
}

/**
 * The YAML for a library template file. The first five lines are exactly what
 * `flipbook template add` writes; role and layout follow only when set.
 */
export function templateSource(fields: TemplateFields): string {
  const lines = [
    `column: ${fields.column}`,
    `row: ${fields.row}`,
    `width: ${fields.width}`,
    `height: ${fields.height}`,
    `align: ${fields.align}`,
    ...(fields.role ? [`role: ${fields.role}`] : []),
    ...(fields.layout ? [`layout: ${fields.layout}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/** The merge patch from `before` to `after` (null removes role or layout). */
export function templatePatch(before: TemplateFields | null, after: TemplateFields): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ["column", "row", "width", "height", "align", "role", "layout"] as const) {
    const value = after[key] ?? null;
    if (!before || (before[key] ?? null) !== value) {
      if (value !== null || before) patch[key] = value;
    }
  }
  return patch;
}

/** Moves or resizes a region by one cell, keeping it inside the grid. */
export function nudge(region: Region, key: string, resize: boolean): Region {
  const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  if (!delta) return region;
  const [dx, dy] = delta as [number, number];
  if (resize) {
    const width = Math.min(Math.max(region.width + dx, 1), 4 - region.column);
    const height = Math.min(Math.max(region.height + dy, 1), 4 - region.row);
    return { ...region, width, height };
  }
  const column = Math.min(Math.max(region.column + dx, 1), 4 - region.width);
  const row = Math.min(Math.max(region.row + dy, 1), 4 - region.height);
  return { ...region, column, row };
}

/** The region spanning two cells (drag start and current cell). */
export function spanCells(a: { column: number; row: number }, b: { column: number; row: number }): Region {
  return {
    column: Math.min(a.column, b.column),
    row: Math.min(a.row, b.row),
    width: Math.abs(a.column - b.column) + 1,
    height: Math.abs(a.row - b.row) + 1,
  };
}
