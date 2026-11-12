import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  nameProblem,
  nudge,
  regionProblem,
  spanCells,
  templatePatch,
  templateSource,
} from "../src/shared/templateFields.js";
import { tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = path.resolve(here, "../../flipbook-md/bin/flipbook.js");
const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
const base = { column: 1, row: 2, width: 2, height: 1, align: "start" as const, role: null, layout: null };

describe("template fields", () => {
  it("flags regions that leave the grid", () => {
    expect(regionProblem(base)).toBeNull();
    expect(regionProblem({ ...base, column: 3 })).toMatch(/right edge/);
    expect(regionProblem({ ...base, row: 3, height: 2 })).toMatch(/bottom edge/);
    expect(regionProblem({ ...base, width: 0 })).toMatch(/start at 1/);
  });

  it("flags reserved and invalid names", () => {
    expect(nameProblem("quote")).toBeNull();
    for (const name of ["flow", "cover", "summary"]) expect(nameProblem(name)).toMatch(/built-in/);
    expect(nameProblem("Quote")).toMatch(/lowercase/);
    expect(nameProblem("../x")).toMatch(/lowercase/);
    expect(nameProblem("")).toMatch(/Name/);
  });

  it("moves and resizes with the keyboard inside the grid", () => {
    expect(nudge(base, "ArrowRight", false)).toMatchObject({ column: 2, width: 2 });
    expect(nudge({ ...base, column: 2 }, "ArrowRight", false)).toMatchObject({ column: 2 });
    expect(nudge(base, "ArrowDown", true)).toMatchObject({ height: 2 });
    expect(nudge({ ...base, height: 2 }, "ArrowDown", true)).toMatchObject({ height: 2 });
    expect(nudge(base, "ArrowLeft", true)).toMatchObject({ width: 1 });
    expect(spanCells({ column: 3, row: 1 }, { column: 2, row: 2 })).toEqual({
      column: 2,
      row: 1,
      width: 2,
      height: 2,
    });
  });

  it("builds a patch of only what changed", () => {
    expect(templatePatch(base, { ...base, align: "center" })).toEqual({ align: "center" });
    expect(templatePatch({ ...base, role: "quote" }, base)).toEqual({ role: null });
    expect(templatePatch(null, base)).toEqual({ column: 1, row: 2, width: 2, height: 1, align: "start" });
  });

  it.skipIf(!cli)("writes the same file as flipbook template add", async () => {
    const home = await tempDir("studio-cli-home-");
    const cwd = await tempDir("studio-cli-cwd-");
    await promisify(execFile)(
      process.execPath,
      [
        cli!,
        "template",
        "add",
        "quote",
        "--column",
        "1",
        "--row",
        "2",
        "--width",
        "2",
        "--height",
        "1",
        "--align",
        "start",
      ],
      { cwd, env: { ...process.env, FLIPBOOK_HOME: home } },
    );
    expect(templateSource(base)).toBe(await fs.readFile(path.join(home, "templates/quote.yml"), "utf8"));
  });
});
