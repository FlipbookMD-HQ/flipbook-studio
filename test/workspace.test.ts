import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspace } from "../src/server/workspace.js";
import { encodeDeckId } from "../src/server/paths.js";
import { FOLDER_DECK, SINGLE_DECK, tempDir, write } from "./helpers.js";

let home: string | undefined;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

function prefixed(files: Record<string, string>, prefix: string) {
  return Object.fromEntries(Object.entries(files).map(([name, body]) => [`${prefix}/${name}`, body]));
}

describe("scanWorkspace", () => {
  it("returns no decks for an empty folder", async () => {
    const root = await tempDir();
    const workspace = await scanWorkspace(root, process.env.FLIPBOOK_HOME!);
    expect(workspace.decks).toEqual([]);
    expect(workspace.root).toBe(root);
  });

  it("finds top-level single files and folder decks, with Unicode and spaces in names", async () => {
    const root = await tempDir();
    await write(root, {
      "my talk.slide.md": SINGLE_DECK,
      "notes.md": "# not a deck",
      ...prefixed(FOLDER_DECK, "café deck"),
      ...prefixed(FOLDER_DECK, "nested/inner"),
      ".flipbook-studio-tmp/x.slide.md": SINGLE_DECK,
    });
    const { decks } = await scanWorkspace(root, process.env.FLIPBOOK_HOME!);
    expect(decks.map((deck) => [deck.path, deck.kind, deck.title, deck.slideCount])).toEqual([
      ["café deck", "folder", "Folder deck", 2],
      ["my talk.slide.md", "single", "Single", 2],
    ]);
    expect(decks[0]!.id).toBe(encodeDeckId("café deck"));
    expect(decks.every((deck) => deck.error === null)).toBe(true);
  });

  it("lists a broken deck with its error", async () => {
    const root = await tempDir();
    await write(root, { "broken/presentation.yml": "title: Broken\nslides:\n  - slides/missing.slide.md\n" });
    const { decks } = await scanWorkspace(root, process.env.FLIPBOOK_HOME!);
    expect(decks).toHaveLength(1);
    expect(decks[0]!.error).toMatchObject({
      code: "DECK_LOAD_FAILED",
      path: "broken",
      message: expect.stringContaining("missing.slide.md"),
    });
  });

  it("excludes a symlinked deck that lives outside the root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await write(outside, FOLDER_DECK);
    await fs.symlink(outside, path.join(root, "linked"));
    await write(root, { "inside.slide.md": SINGLE_DECK });
    const { decks } = await scanWorkspace(root, process.env.FLIPBOOK_HOME!);
    expect(decks.map((deck) => deck.path)).toEqual(["inside.slide.md"]);
  });

  it("lists library kits, telling groups from templates", async () => {
    const root = await tempDir();
    const library = process.env.FLIPBOOK_HOME!;
    await write(library, {
      "themes/sunset.css": ":root{}",
      "templates/templates.yml": "quote:\n  column: 1\n  row: 1\n",
      "templates/my_kit.yml": "name: My kit\nthemes: [sunset]\ntemplates: {}\nblueprint: {}\n",
      "blueprints/talk.yml": "pages: []\n",
    });
    const { library: kits } = await scanWorkspace(root, library);
    expect(kits.themes).toContainEqual({ kind: "theme", name: "sunset", scope: "library" });
    expect(kits.themes.some((theme) => theme.scope === "builtin")).toBe(true);
    expect(kits.groups).toContainEqual({ kind: "group", name: "my_kit", scope: "library" });
    expect(kits.groups.some((group) => group.scope === "builtin")).toBe(true);
    expect(kits.templates).toContainEqual({ kind: "template", name: "templates", scope: "library" });
    expect(kits.templates).toContainEqual({ kind: "template", name: "cover", scope: "builtin" });
    expect(kits.templates.some((template) => template.name === "my_kit")).toBe(false);
    expect(kits.blueprints).toEqual([{ kind: "blueprint", name: "talk", scope: "library" }]);
  });
});
