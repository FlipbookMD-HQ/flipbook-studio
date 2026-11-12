import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  STARTER,
  asBlueprint,
  blueprintProblems,
  blueprintYaml,
  mergeDiff,
  patchYaml,
  renameType,
} from "../src/shared/blueprintModel.js";

const SOURCE = `# Talks
pages:
  - type: cover
  - type: point
    repeat:
      min: 3
      max: 6
types:
  cover:
    template: cover # always
  point:
    allow: [heading, paragraph, list]
`;
const templates = new Set(["flow", "cover", "summary"]);

describe("blueprint model", () => {
  it("flags problems inline: undefined types, max below min, unknown templates, no pages", () => {
    const blueprint = asBlueprint(parse(SOURCE))!;
    expect(blueprintProblems(blueprint, templates)).toEqual([]);
    const broken = {
      pages: [{ type: "epilogue" }, { type: "point", repeat: { min: 4, max: 2 } }, {}],
      types: { point: { template: "nowhere" }, Bad: {} },
    };
    expect(
      blueprintProblems(broken, templates).map((problem) => `${problem.where}: ${problem.message}`),
    ).toEqual([
      'types.point: Unknown template "nowhere".',
      'types.Bad: "Bad" is not a valid type name (lowercase letters, digits and -).',
      'pages.1: Type "epilogue" is not defined.',
      "pages.2: Repeat max can't be below min.",
      "pages.3: Pick a page type.",
    ]);
    expect(blueprintProblems({ pages: [], types: {} }, templates)[0]!.message).toMatch(/at least one page/);
  });

  it("renames a type in place and in every page", () => {
    const blueprint = {
      pages: [{ type: "point" }, { any: ["cover", "point"] }],
      types: { cover: {}, point: { max_chars: 9 } },
    };
    const renamed = renameType(blueprint, "point", "idea");
    expect(Object.keys(renamed.types)).toEqual(["cover", "idea"]);
    expect(renamed.types.idea).toEqual({ max_chars: 9 });
    expect(renamed.pages).toEqual([{ type: "idea" }, { any: ["cover", "idea"] }]);
    expect(renameType(blueprint, "point", "cover")).toBe(blueprint);
  });

  it("diffs into a merge patch and applies it to the text keeping comments", () => {
    const before = parse(SOURCE);
    const after = structuredClone(before);
    after.types.point.max_items = 3;
    delete after.types.point.allow;
    after.types.cover.template = "summary";
    const patch = mergeDiff(before, after);
    expect(patch).toEqual({
      types: { cover: { template: "summary" }, point: { allow: null, max_items: 3 } },
    });
    expect(patchYaml(SOURCE, patch)).toBe(
      SOURCE.replace("template: cover # always", "template: summary # always").replace(
        "    allow: [heading, paragraph, list]\n",
        "    max_items: 3\n",
      ),
    );
    expect(patchYaml(SOURCE, {})).toBe(SOURCE);
  });

  it("writes a new blueprint as YAML that parses back to the same value", () => {
    expect(parse(blueprintYaml(STARTER))).toEqual(STARTER);
  });
});
