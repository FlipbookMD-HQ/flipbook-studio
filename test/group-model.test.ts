import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  asGroup,
  groupProblems,
  groupYaml,
  remapBlueprint,
  renamedGroupSource,
  starterGroup,
} from "../src/shared/groupModel.js";

describe("group model", () => {
  it("a starter kit has no problems and round-trips through YAML", () => {
    const group = starterGroup("brand");
    expect(groupProblems(group)).toEqual([]);
    expect(asGroup(parse(groupYaml(group)))).toEqual(group);
  });

  it("flags a style outside the themes, bad chrome values, unprefixed templates and blueprint problems", () => {
    const group = starterGroup("brand");
    group.style = "marvel-herbie";
    group.chrome!.counter.line_length = "wide";
    group.chrome!.counter.ornament = "<b>";
    group.templates.other = { column: 3, row: 1, width: 2, height: 1 };
    group.blueprint.types.cover = { template: "nowhere" };
    expect(groupProblems(group).map((problem) => `${problem.where}: ${problem.message}`)).toEqual([
      "themes: The style must be one of the selected themes.",
      "chrome: Line length must be a percent or px value, such as 40% or 240px.",
      "chrome: The ornament must be a short glyph (up to 4 characters) or an image path.",
      'templates.other: "other" must start with brand_.',
      "templates.other: The region spills past the grid's right edge.",
      'blueprint.types.cover: Unknown template "nowhere".',
    ]);
  });

  it("renames prefixes and references like core, keeping comments", () => {
    const source = `# Kit\nname: brand\ntemplates:\n  # big\n  brand_cover:\n    column: 1\nblueprint:\n  types:\n    cover:\n      template: brand_cover\n    point:\n      template: flow\n`;
    expect(renamedGroupSource(source, "brand", "talks")).toBe(
      source.replace("name: brand", "name: talks").replaceAll("brand_cover", "talks_cover"),
    );
  });

  it("remaps a library blueprint's template names to the kit's prefixed templates", () => {
    const group = starterGroup("brand");
    group.templates.brand_quote = { column: 1, row: 1, width: 3, height: 1 };
    const remapped = remapBlueprint(
      {
        pages: [{ type: "q" }],
        types: { q: { template: "quote" }, c: { template: "cover" }, x: { template: "other" } },
      },
      group,
    );
    expect(remapped.types).toEqual({
      q: { template: "brand_quote" },
      c: { template: "brand_cover" },
      x: { template: "other" },
    });
  });
});
