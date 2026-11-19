import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitRunner, type GitResult, type GitRunOptions } from "../src/server/history/git.js";
import { SettingsStore } from "../src/server/settings.js";
import { encodeDeckId } from "../src/server/paths.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";
import { git, gitAs, gitEnv, initRepo, runner } from "./support/git.js";

// US-26 · 1.1.2: POST …/versions/:sha/restore and POST …/discard on real temporary repositories.

const TALK = encodeDeckId("talk");
const SOLO = encodeDeckId("solo.slide.md");

async function studio(workspace: string, gitRunner: GitRunner = runner()) {
  const settings = await SettingsStore.open(await tempDir("studio-restore-settings-"), () => {});
  const app = await makeApp(workspace, [], { git: gitRunner, settings });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    restore: (sha: string, expectHead: string, id = TALK) =>
      call("POST", `/api/decks/${id}/versions/${sha}/restore`, { expectHead }),
    discard: (expectHead: string, id = TALK) => call("POST", `/api/decks/${id}/discard`, { expectHead }),
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
      if (item.name === ".git") continue;
      const absolute = path.join(folder, item.name);
      if (item.isDirectory()) await walk(absolute);
      else out[path.relative(dir, absolute)] = await fs.readFile(absolute, "utf8");
    }
  };
  await walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** What git itself holds: HEAD, every ref, the index file, and the commit count. */
async function gitState(repo: string) {
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: (await fs.readFile(path.join(repo, ".git/index"))).toString("base64"),
    count: git(repo, "rev-list", "--count", "--all").trim(),
  };
}

const V2 = {
  "presentation.yml": "title: Folder deck\nslides:\n  - slides/01.slide.md\n  - slides/03.slide.md\n",
  "slides/01.slide.md": "# First, edited\n\n![logo](../assets/logo.svg)\n\n![new](../assets/new.svg)\n",
  "slides/03.slide.md": "# Third\n",
  "assets/logo.svg": FOLDER_DECK["assets/logo.svg"],
  "assets/new.svg": "<svg>new</svg>",
};

/** v1 = FOLDER_DECK; v2 removes slide 02, adds slide 03 and an image, and edits slide 01. */
async function twoVersions() {
  const workspace = await tempDir("studio-restore-");
  await write(path.join(workspace, "talk"), FOLDER_DECK);
  await write(workspace, { ".gitignore": "*.log\n" });
  initRepo(workspace);
  const v1 = commit(workspace, "v1");
  await fs.rm(path.join(workspace, "talk/slides/02.slide.md"));
  await write(path.join(workspace, "talk"), V2);
  const v2 = commit(workspace, "v2");
  return { workspace, deckDir: path.join(workspace, "talk"), v1, v2 };
}

describe("POST /api/decks/:id/versions/:sha/restore", () => {
  it("puts back added and removed slides and assets, as one undoable step, with no commit", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    await write(deckDir, { "build.log": "ignored, kept" });
    const before = await gitState(workspace);
    const { restore, undo, redo, call } = await studio(workspace);

    const restored = await restore(v1, v2);
    expect(restored.status).toBe(200);
    expect(await tree(deckDir)).toEqual({ ...FOLDER_DECK, "build.log": "ignored, kept" });
    expect(restored.body.deck.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slides/01.slide.md",
      "slides/02.slide.md",
    ]);
    expect(restored.body.history).toEqual({ undo: 'Restore "v1"', redo: null });
    expect(restored.body.state).toMatchObject({ state: "ready", dirty: true });
    expect(restored.body.state.head.sha).toBe(v2);
    expect(restored.body.skipped).toEqual([]);
    // No commit, and HEAD, refs and the index are exactly as they were.
    expect(await gitState(workspace)).toEqual(before);

    // Undo brings back v2's exact bytes; redo restores v1 again.
    const undone = await undo();
    expect(undone.status).toBe(200);
    expect(undone.body.history).toEqual({ undo: null, redo: 'Restore "v1"' });
    expect(await tree(deckDir)).toEqual({ ...V2, "build.log": "ignored, kept" });
    expect((await redo()).status).toBe(200);
    expect(await tree(deckDir)).toEqual({ ...FOLDER_DECK, "build.log": "ignored, kept" });
    expect(await gitState(workspace)).toEqual(before);

    // The result can be saved as a new version; no version was deleted.
    const saved = await call("POST", `/api/decks/${TALK}/versions`, { note: "back to v1" });
    expect(saved.status).toBe(201);
    expect(git(workspace, "log", "--format=%s").trim().split("\n")).toEqual(["back to v1", "v2", "v1"]);
    expect(git(workspace, "diff", "--stat", v1, "HEAD", "--", "talk")).toBe("");
  });

  it("409 DECK_DIRTY with the changes when the deck changed since its last version; nothing written", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    await write(deckDir, { "slides/03.slide.md": "# Third, unsaved version\n", "notes.md": "new\n" });
    const before = await tree(deckDir);
    const { restore } = await studio(workspace);
    const response = await restore(v1, v2);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DECK_DIRTY");
    expect(response.body.error.details.changes).toEqual([
      { path: "notes.md", status: "added" },
      { path: "slides/03.slide.md", status: "modified" },
    ]);
    expect(await tree(deckDir)).toEqual(before);
  });

  it("409 VERSION_STALE when the deck's latest version moved; nothing written", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    await write(deckDir, { "slides/03.slide.md": "# Third v3\n" });
    const v3 = commit(workspace, "v3");
    const before = await tree(deckDir);
    const { restore } = await studio(workspace);
    const response = await restore(v1, v2);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "VERSION_STALE", details: { head: v3 } });
    expect(await tree(deckDir)).toEqual(before);
  });

  it("404 VERSION_NOT_FOUND and 422 for a malformed sha", async () => {
    const { workspace, v2 } = await twoVersions();
    const { restore } = await studio(workspace);
    expect((await restore("e".repeat(40), v2)).body.error.code).toBe("VERSION_NOT_FOUND");
    const bad = await restore("HEAD", v2);
    expect(bad.status).toBe(422);
    expect((await restore(v2, "--force")).status).toBe(422);
  });

  it("a file changed outside Studio while restoring stops the whole write (UNDO_CONFLICT)", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    // Changes a file after the restore was planned, just before it is written.
    class Racing extends GitRunner {
      override async run(args: string[], opts: GitRunOptions): Promise<GitResult> {
        if (args[0] === "log" && args.includes("--format=%s"))
          await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# Edited elsewhere\n");
        return super.run(args, opts);
      }
    }
    const { restore, call } = await studio(workspace, new Racing({ env: gitEnv() }));
    const response = await restore(v1, v2);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: "UNDO_CONFLICT",
      details: { files: ["slides/01.slide.md"] },
    });
    expect(await tree(deckDir)).toEqual({ ...V2, "slides/01.slide.md": "# Edited elsewhere\n" });
    expect((await call("GET", `/api/decks/${TALK}/history`)).body).toEqual({ undo: null, redo: null });
  });

  it("undo refuses when a restored file changed outside Studio afterwards", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    const { restore, undo } = await studio(workspace);
    expect((await restore(v1, v2)).status).toBe(200);
    await write(deckDir, { "slides/02.slide.md": "# Changed by hand\n" });
    const response = await undo();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("UNDO_CONFLICT");
    expect(await tree(deckDir)).toEqual({ ...FOLDER_DECK, "slides/02.slide.md": "# Changed by hand\n" });
  });

  it("a single-file deck: keeps an untracked image and never deletes shared assets", async () => {
    const workspace = await tempDir("studio-restore-single-");
    await write(workspace, {
      "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n![a](assets/a.svg)\n",
      "assets/a.svg": "<svg>a1</svg>",
    });
    initRepo(workspace);
    const v1 = commit(workspace, "v1");
    await write(workspace, {
      "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n![b](assets/b.svg)\n\n---\n\n# Two\n",
      "assets/b.svg": "<svg>b</svg>",
    });
    await fs.rm(path.join(workspace, "assets/a.svg"));
    const v2 = commit(workspace, "v2");
    // Not referenced by the deck, so not part of it: left alone.
    await write(workspace, { "assets/loose.svg": "<svg>loose</svg>" });
    const { restore, undo } = await studio(workspace);
    const response = await restore(v1, v2, SOLO);
    expect(response.status).toBe(200);
    expect(response.body.deck.slides).toHaveLength(1);
    expect(await tree(workspace)).toEqual({
      ".gitignore": undefined,
      "assets/a.svg": "<svg>a1</svg>",
      "assets/b.svg": "<svg>b</svg>",
      "assets/loose.svg": "<svg>loose</svg>",
      "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n![a](assets/a.svg)\n",
    });
    expect((await undo(SOLO)).status).toBe(200);
    await expect(fs.access(path.join(workspace, "assets/a.svg"))).rejects.toThrow();
    expect(await fs.readFile(path.join(workspace, "solo.slide.md"), "utf8")).toContain("# Two");
  });
});

describe("POST /api/decks/:id/discard", () => {
  it("puts back the latest version, deletes new files that aren't ignored, and is undoable", async () => {
    const { workspace, deckDir, v2 } = await twoVersions();
    const changed = {
      "presentation.yml": "title: Folder deck\nslides:\n  - slides/01.slide.md\n  - slides/04.slide.md\n",
      "slides/01.slide.md": "# First, unsaved\n",
      "slides/04.slide.md": "# Brand new\n",
      "assets/extra.svg": "<svg>extra</svg>",
      "build.log": "ignored, kept",
    };
    await write(deckDir, changed);
    await fs.rm(path.join(deckDir, "slides/03.slide.md"));
    const dirty = await tree(deckDir);
    const before = await gitState(workspace);
    const { discard, undo, call } = await studio(workspace);

    const response = await discard(v2);
    expect(response.status).toBe(200);
    expect(await tree(deckDir)).toEqual({ ...V2, "build.log": "ignored, kept" });
    expect(response.body.history.undo).toBe('Discard changes since "v2"');
    expect(response.body.state).toMatchObject({ dirty: false, changes: [] });
    expect(await gitState(workspace)).toEqual(before);

    expect((await undo()).status).toBe(200);
    expect(await tree(deckDir)).toEqual(dirty);
    // Nothing left to discard once it's discarded again.
    expect((await call("POST", `/api/decks/${TALK}/redo`)).status).toBe(200);
    const again = await discard(v2);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NO_CHANGES");
  });

  it("restore after discard: the dirty dialog's Discard then Restore flow", async () => {
    const { workspace, deckDir, v1, v2 } = await twoVersions();
    await write(deckDir, { "notes.md": "untracked\n" });
    const { discard, restore } = await studio(workspace);
    expect((await restore(v1, v2)).body.error.code).toBe("DECK_DIRTY");
    expect((await discard(v2)).status).toBe(200);
    expect((await restore(v1, v2)).status).toBe(200);
    expect(await tree(deckDir)).toEqual(FOLDER_DECK);
  });

  it("409 VERSION_STALE when the head moved", async () => {
    const { workspace, deckDir, v1 } = await twoVersions();
    await write(deckDir, { "notes.md": "x\n" });
    const { discard } = await studio(workspace);
    const response = await discard(v1);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_STALE");
    expect(await fs.readFile(path.join(deckDir, "notes.md"), "utf8")).toBe("x\n");
  });
});
