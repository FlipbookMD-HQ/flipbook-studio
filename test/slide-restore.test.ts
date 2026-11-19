import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { encodeDeckId } from "../src/server/paths.js";
import { chunkLayout, insertManifestEntry, placeChunk, rewriteImage } from "../src/server/history/slides.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";
import { git, gitAs, initRepo, runner } from "./support/git.js";

// US-27 · 1.2.1.2: POST …/versions/:sha/slides/:slideId/restore on real temporary repositories.

const TALK = encodeDeckId("talk");
const SOLO = encodeDeckId("solo.slide.md");
const LOGO = FOLDER_DECK["assets/logo.svg"];
const OTHER_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>';

async function studio(workspace: string) {
  const settings = await SettingsStore.open(await tempDir("studio-slide-restore-settings-"), () => {});
  const app = await makeApp(workspace, [], { git: runner(), settings });
  const call = async (method: string, url: string) => {
    const response = await app.request(url, { method, headers: headers() });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    restore: (sha: string, slideId: string, id = TALK) =>
      call("POST", `/api/decks/${id}/versions/${sha}/slides/${encodeURIComponent(slideId)}/restore`),
    view: (sha: string, id = TALK) => call("GET", `/api/decks/${id}/versions/${sha}`),
    undo: (id = TALK) => call("POST", `/api/decks/${id}/undo`),
    redo: (id = TALK) => call("POST", `/api/decks/${id}/redo`),
  };
}

const commit = (repo: string, note: string) => {
  gitAs(repo, "add", "-A");
  gitAs(repo, "commit", "-q", "-m", note);
  return git(repo, "rev-parse", "HEAD").trim();
};

/** Every file under `dir` (relative, sorted) → its bytes as text; .git is left out. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string) => {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.name === ".git" || item.name === ".flipbook-studio-tmp") continue;
      const absolute = path.join(folder, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isSymbolicLink()) out[path.relative(dir, absolute)] = `-> ${await fs.readlink(absolute)}`;
      else out[path.relative(dir, absolute)] = await fs.readFile(absolute, "utf8");
    }
  };
  await walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const gitState = async (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD").trim(),
  refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
  index: (await fs.readFile(path.join(repo, ".git/index"))).toString("base64"),
  count: git(repo, "rev-list", "--count", "--all").trim(),
  status: git(repo, "status", "--porcelain"),
});

const MANIFEST = (...slides: string[]) =>
  `title: Folder deck\n# The slides, in order.\nslides:\n${slides.map((slide) => `  - "slides/${slide}.slide.md"`).join("\n")}\ntheme: midnight\n`;

const V1 = {
  ...FOLDER_DECK,
  "presentation.yml": MANIFEST("01", "02", "03"),
  "slides/02.slide.md": "# Second\n\nText.\n",
  "slides/03.slide.md": "# Third\n",
};

async function folderDeck() {
  const workspace = await tempDir("studio-slide-restore-");
  const deckDir = path.join(workspace, "talk");
  await write(deckDir, V1);
  initRepo(workspace);
  const v1 = commit(workspace, "v1");
  return { workspace, deckDir, v1 };
}

describe("restore one slide in a folder deck", () => {
  it("puts back a modified slide's bytes; no other file changes; one undoable step; no commit", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, edited\n");
    await fs.writeFile(path.join(deckDir, "slides/03.slide.md"), "# Third, edited\n");
    const edited = await tree(deckDir);
    const before = await gitState(workspace);
    const { restore, undo, redo } = await studio(workspace);

    const response = await restore(v1, "slides/01.slide.md");
    expect(response.status).toBe(200);
    expect(response.body.slideId).toBe("slides/01.slide.md");
    expect(response.body.history).toEqual({ undo: 'Restore slide "First"', redo: null });
    expect(response.body.restoredAssets).toEqual([]);
    expect(response.body.skippedAssets).toEqual([]);
    expect(response.body.deck.slides.map((slide: { title: string }) => slide.title)).toEqual([
      "First",
      "Second",
      "Third, edited",
    ]);
    expect(await tree(deckDir)).toEqual({ ...edited, "slides/01.slide.md": V1["slides/01.slide.md"] });
    // No DECK_DIRTY check, no commit, and HEAD, refs and the index are untouched.
    expect({ ...(await gitState(workspace)), status: "" }).toEqual({ ...before, status: "" });

    expect((await undo()).body.history).toEqual({ undo: null, redo: 'Restore slide "First"' });
    expect(await tree(deckDir)).toEqual(edited);
    expect((await redo()).status).toBe(200);
    expect(await tree(deckDir)).toEqual({ ...edited, "slides/01.slide.md": V1["slides/01.slide.md"] });
  });

  it("adds a gone slide back at its old index, under its old file name, keeping the manifest's style", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.rm(path.join(deckDir, "slides/02.slide.md"));
    await fs.writeFile(path.join(deckDir, "presentation.yml"), MANIFEST("01", "03"));
    const now = await tree(deckDir);
    const { restore, view, undo } = await studio(workspace);
    expect((await view(v1)).body.slides[1].status).toBe("gone");

    const response = await restore(v1, "slides/02.slide.md");
    expect(response.status).toBe(200);
    expect(response.body.slideId).toBe("slides/02.slide.md");
    expect(response.body.history.undo).toBe('Restore slide "Second"');
    expect(await tree(deckDir)).toEqual({
      ...now,
      "presentation.yml": V1["presentation.yml"],
      "slides/02.slide.md": V1["slides/02.slide.md"],
    });
    expect((await view(v1)).body.slides.map((slide: { status: string }) => slide.status)).toEqual([
      "same",
      "same",
      "same",
    ]);
    await undo();
    expect(await tree(deckDir)).toEqual(now);
  });

  it("puts a gone slide at min(oldIndex, slideCount) when the deck is shorter now", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.rm(path.join(deckDir, "slides/02.slide.md"));
    await fs.rm(path.join(deckDir, "slides/03.slide.md"));
    await fs.writeFile(path.join(deckDir, "presentation.yml"), MANIFEST("01"));
    const { restore } = await studio(workspace);
    const response = await restore(v1, "slides/03.slide.md");
    expect(response.status).toBe(200);
    expect(response.body.deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slides/01.slide.md",
      "slides/03.slide.md",
    ]);
    expect(await fs.readFile(path.join(deckDir, "presentation.yml"), "utf8")).toBe(MANIFEST("01", "03"));
  });

  it("404 SLIDE_NOT_FOUND for a slide the version doesn't have; 404 VERSION_NOT_FOUND; nothing written", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    const now = await tree(deckDir);
    const { restore } = await studio(workspace);
    const slide = await restore(v1, "slides/09.slide.md");
    expect(slide.status).toBe(404);
    expect(slide.body.error.code).toBe("SLIDE_NOT_FOUND");
    const version = await restore("e".repeat(40), "slides/01.slide.md");
    expect(version.status).toBe(404);
    expect(version.body.error.code).toBe("VERSION_NOT_FOUND");
    expect((await restore("abc", "slides/01.slide.md")).status).toBe(422);
    expect(await tree(deckDir)).toEqual(now);
  });

  it("undo refuses with 409 UNDO_CONFLICT when the slide changed outside Studio; a same-bytes restore adds no step", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, edited\n");
    const { restore, undo } = await studio(workspace);
    expect((await restore(v1, "slides/01.slide.md")).status).toBe(200);
    // Restoring a slide that already matches the version writes nothing and adds no undo step.
    const again = await restore(v1, "slides/01.slide.md");
    expect(again.status).toBe(200);
    expect(again.body.history).toEqual({ undo: 'Restore slide "First"', redo: null });

    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# Changed outside\n");
    const conflict = await undo();
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("UNDO_CONFLICT");
    expect(await fs.readFile(path.join(deckDir, "slides/01.slide.md"), "utf8")).toBe("# Changed outside\n");
  });
});

describe("restore one slide in a single-file deck", () => {
  const SOLO_V1 =
    "---\ntitle: Solo\n---\n# One\n\nHello.\n\n---\n\n# Two\n\n![logo](assets/logo.svg)\n\n---\n\n# Three\n";

  async function soloDeck() {
    const workspace = await tempDir("studio-slide-restore-solo-");
    await write(workspace, { "solo.slide.md": SOLO_V1, "assets/logo.svg": LOGO });
    initRepo(workspace);
    const v1 = commit(workspace, "v1");
    return { workspace, v1, file: path.join(workspace, "solo.slide.md") };
  }

  it("matches by position: a modified slide's chunk is replaced and every other byte stays", async () => {
    const { workspace, v1, file } = await soloDeck();
    const edited =
      "---\ntitle: Solo\n---\n# One, edited\n\nHello.\n\n---\n\n# Two, edited\n\n---\n\n# Three\n";
    await fs.writeFile(file, edited);
    const before = await gitState(workspace);
    const { restore, undo } = await studio(workspace);
    const response = await restore(v1, "#1", SOLO);
    expect(response.status).toBe(200);
    expect(response.body.slideId).toBe("#1");
    expect(response.body.history.undo).toBe('Restore slide "Two"');
    expect(await fs.readFile(file, "utf8")).toBe(
      edited.replace("# Two, edited", "# Two\n\n![logo](assets/logo.svg)"),
    );
    expect({ ...(await gitState(workspace)), status: "" }).toEqual({ ...before, status: "" });
    await undo(SOLO);
    expect(await fs.readFile(file, "utf8")).toBe(edited);
  });

  it("a gone slide (past the end now) is appended", async () => {
    const { workspace, v1, file } = await soloDeck();
    await fs.writeFile(file, "---\ntitle: Solo\n---\n# One\n\nHello.\n");
    const { restore, view } = await studio(workspace);
    expect((await view(v1, SOLO)).body.slides.map((slide: { status: string }) => slide.status)).toEqual([
      "same",
      "gone",
      "gone",
    ]);
    const response = await restore(v1, "#2", SOLO);
    expect(response.status).toBe(200);
    expect(response.body.slideId).toBe("#1");
    expect(await fs.readFile(file, "utf8")).toBe(
      "---\ntitle: Solo\n---\n# One\n\nHello.\n\n---\n\n# Three\n",
    );
  });
});

describe("a restored slide's images", () => {
  it("writes a missing image back to assets/", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.rm(path.join(deckDir, "assets/logo.svg"));
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, no image\n");
    const { restore, undo } = await studio(workspace);
    const response = await restore(v1, "slides/01.slide.md");
    expect(response.body.restoredAssets).toEqual([{ from: "assets/logo.svg", to: "assets/logo.svg" }]);
    expect(await fs.readFile(path.join(deckDir, "assets/logo.svg"), "utf8")).toBe(LOGO);
    await undo();
    await expect(fs.access(path.join(deckDir, "assets/logo.svg"))).rejects.toThrow();
  });

  it("a name taken by a different file gets -2 and the reference is rewritten; nothing is overwritten", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.writeFile(path.join(deckDir, "assets/logo.svg"), OTHER_LOGO);
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, no image\n");
    const { restore, undo } = await studio(workspace);
    const response = await restore(v1, "slides/01.slide.md");
    expect(response.status).toBe(200);
    expect(response.body.restoredAssets).toEqual([{ from: "assets/logo.svg", to: "assets/logo-2.svg" }]);
    expect(await fs.readFile(path.join(deckDir, "assets/logo.svg"), "utf8")).toBe(OTHER_LOGO);
    expect(await fs.readFile(path.join(deckDir, "assets/logo-2.svg"), "utf8")).toBe(LOGO);
    expect(await fs.readFile(path.join(deckDir, "slides/01.slide.md"), "utf8")).toBe(
      "# First\n\n![logo](../assets/logo-2.svg)\n",
    );
    // Undo is one step: the slide and the new image go together.
    await undo();
    await expect(fs.access(path.join(deckDir, "assets/logo-2.svg"))).rejects.toThrow();
    expect(await fs.readFile(path.join(deckDir, "slides/01.slide.md"), "utf8")).toBe("# First, no image\n");
  });

  it("an image already there with the same bytes is reused, not copied", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, no image\n");
    // Same name, same bytes: nothing to write.
    const { restore, undo } = await studio(workspace);
    let response = await restore(v1, "slides/01.slide.md");
    expect(response.body.restoredAssets).toEqual([]);
    expect(await fs.readdir(path.join(deckDir, "assets"))).toEqual(["logo.svg"]);
    await undo();
    // Name taken by a different file, but logo-2.svg already holds the version's bytes: reused.
    await fs.writeFile(path.join(deckDir, "assets/logo.svg"), OTHER_LOGO);
    await fs.writeFile(path.join(deckDir, "assets/logo-2.svg"), LOGO);
    response = await restore(v1, "slides/01.slide.md");
    expect(response.body.restoredAssets).toEqual([]);
    expect((await fs.readdir(path.join(deckDir, "assets"))).sort()).toEqual(["logo-2.svg", "logo.svg"]);
    expect(await fs.readFile(path.join(deckDir, "slides/01.slide.md"), "utf8")).toContain(
      "../assets/logo-2.svg",
    );
  });

  it("skips symlinks and images over 8 MB, listing them in skippedAssets", async () => {
    const workspace = await tempDir("studio-slide-restore-skip-");
    const deckDir = path.join(workspace, "talk");
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    await write(deckDir, {
      ...V1,
      "slides/02.slide.md": "# Second\n\n![big](../assets/big.png)\n\n![link](../assets/link.svg)\n",
    });
    await fs.writeFile(path.join(deckDir, "assets/big.png"), big);
    await fs.symlink("logo.svg", path.join(deckDir, "assets/link.svg"));
    initRepo(workspace);
    const v1 = commit(workspace, "v1");
    await fs.rm(path.join(deckDir, "assets/big.png"));
    await fs.rm(path.join(deckDir, "assets/link.svg"));
    await fs.writeFile(path.join(deckDir, "slides/02.slide.md"), "# Second, edited\n");
    const { restore } = await studio(workspace);
    const response = await restore(v1, "slides/02.slide.md");
    expect(response.status).toBe(200);
    expect(response.body.restoredAssets).toEqual([]);
    expect(response.body.skippedAssets).toEqual([
      { path: "assets/big.png", reason: "larger than 8 MB" },
      { path: "assets/link.svg", reason: "symlink" },
    ]);
    expect((await fs.readdir(path.join(deckDir, "assets"))).sort()).toEqual(["logo.svg"]);
    expect(await fs.readFile(path.join(deckDir, "slides/02.slide.md"), "utf8")).toContain("# Second\n");
  });
});

describe("helpers", () => {
  it("chunkLayout and placeChunk keep separators and other chunks' bytes", () => {
    const text = "﻿---\ntitle: X\n---\n\n# A\n\n---\n\n# B\r\n";
    expect(chunkLayout(text).cores).toEqual(["# A", "# B"]);
    expect(placeChunk(text, 1, "# C")).toEqual({
      text: "﻿---\ntitle: X\n---\n\n# A\n\n---\n\n# C\r\n",
      index: 1,
    });
    expect(placeChunk("# A\n", 5, "# B")).toEqual({ text: "# A\n\n---\n\n# B\n", index: 1 });
    expect(placeChunk("---\ntitle: X\n---\n", 0, "# A").text).toBe("---\ntitle: X\n---\n\n# A\n");
    // A `---` inside a notes comment isn't a separator.
    expect(chunkLayout("# A\n\n<!-- notes:\n---\n-->\n\n---\n\n# B\n").cores).toHaveLength(2);
  });

  it("insertManifestEntry adds one line in the list's style, or falls back to the YAML document", () => {
    expect(insertManifestEntry("slides:\n  - a.md\n  - c.md\n", "b.md", 1)).toBe(
      "slides:\n  - a.md\n  - b.md\n  - c.md\n",
    );
    expect(insertManifestEntry("slides:\n  - 'a.md'\n", "it's.md", 5)).toBe(
      "slides:\n  - 'a.md'\n  - 'it''s.md'\n",
    );
    expect(insertManifestEntry('slides:\n  - "a.md"\n', "b.md", 0)).toBe('slides:\n  - "b.md"\n  - "a.md"\n');
    expect(insertManifestEntry("slides: [a.md]\n", "b.md", 1)).toBe("slides: [ a.md, b.md ]\n");
    expect(() => insertManifestEntry("title: x\n", "b.md", 0)).toThrow(/no slides list/);
  });

  it("rewriteImage changes only references to that image in assets/", () => {
    const text =
      '![a](../assets/logo.svg) ![b](assets/logo.svg?x) ![c](assets/logo.svg.bak) <img src="./assets/logo.svg">';
    expect(rewriteImage(text, "logo.svg", "logo-2.svg")).toBe(
      '![a](../assets/logo-2.svg) ![b](assets/logo-2.svg?x) ![c](assets/logo.svg.bak) <img src="./assets/logo-2.svg">',
    );
    expect(rewriteImage("![](assets/my%20logo.png)", "my logo.png", "my-logo-2.png")).toBe(
      "![](assets/my-logo-2.png)",
    );
  });
});
