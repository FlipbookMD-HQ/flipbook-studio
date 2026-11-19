import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeckHistoryService, deckPathspec, parseStatus } from "../src/server/history/versions.js";
import { findDecks, type DeckEntry } from "../src/server/workspace.js";
import { FOLDER_DECK, SINGLE_DECK, tempDir, write } from "./helpers.js";
import { fakeGit, git, gitAs, initRepo, realGit, runner } from "./support/git.js";

// US-23: history state and the deck path spec (D37), on real temporary repositories.

const service = (git = runner(), workspace = "") =>
  new DeckHistoryService({ git, workspace, author: async () => undefined });

async function deck(workspace: string, relative: string): Promise<DeckEntry> {
  const found = (await findDecks(workspace)).find((entry) => entry.relative === relative);
  if (!found) throw new Error(`no deck ${relative}`);
  return found;
}

async function folderWorkspace(name = "talk") {
  const workspace = await tempDir("studio-hist-");
  await write(path.join(workspace, name), FOLDER_DECK);
  return workspace;
}

describe("history state", () => {
  it("no git → no-git with the reason", async () => {
    const workspace = await folderWorkspace();
    const empty = await tempDir("studio-no-git-");
    const state = await service(runner({ env: { PATH: empty } })).state(await deck(workspace, "talk"));
    expect(state).toMatchObject({
      state: "no-git",
      reason: expect.stringMatching(/isn't installed/),
      head: null,
    });
  });

  it("no repository → no-repo, and init is offered at the deck and the workspace", async () => {
    const workspace = await folderWorkspace();
    await write(workspace, { "solo.slide.md": SINGLE_DECK });
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "no-repo",
      repoRoot: null,
      canInit: { deck: true, workspace: true },
      dirty: false,
    });
    // A single-file deck's folder is the workspace, so only the workspace is offered.
    expect((await service().state(await deck(workspace, "solo.slide.md"))).canInit).toEqual({
      deck: false,
      workspace: true,
    });
  });

  it("an empty repo is ready with head null and every deck file added", async () => {
    const workspace = await folderWorkspace();
    initRepo(workspace);
    const state = await service().state(await deck(workspace, "talk"));
    expect(state).toMatchObject({
      state: "ready",
      reason: null,
      repoRoot: workspace,
      head: null,
      dirty: true,
    });
    expect(state.detached).toBe(false);
    expect(state.changes).toEqual([
      { path: "assets/logo.svg", status: "added" },
      { path: "presentation.yml", status: "added" },
      { path: "slides/01.slide.md", status: "added" },
      { path: "slides/02.slide.md", status: "added" },
    ]);
  });

  it("dirty and changes cover the deck's path spec only", async () => {
    const workspace = await folderWorkspace();
    await write(workspace, {
      "notes.txt": "outside",
      "other/presentation.yml": "title: Other\nslides: []\n",
    });
    initRepo(workspace);
    gitAs(workspace, "add", "-A");
    gitAs(workspace, "commit", "-q", "-m", "first");
    const talk = await deck(workspace, "talk");
    let state = await service().state(talk);
    expect(state).toMatchObject({ dirty: false, changes: [] });
    expect(state.head).toMatchObject({ note: "first", author: "Outside", slidesChanged: 2 });
    expect(state.head!.sha).toMatch(/^[0-9a-f]{40}$/);

    await write(workspace, {
      "notes.txt": "changed outside the deck",
      "talk/dist/out.html": "build",
      "talk/exports/a.png": "x",
      "talk/node_modules/m/index.js": "x",
      "talk/slides/dist/nested.txt": "x",
      "talk/.flipbook-studio-tmp/t": "x",
      "talk/slides/02.slide.md": "# Second, edited\n",
      "talk/slides/03.slide.md": "# Third\n",
    });
    await fs.rm(path.join(workspace, "talk/assets/logo.svg"));
    state = await service().state(talk);
    expect(state.dirty).toBe(true);
    expect(state.changes).toEqual([
      { path: "assets/logo.svg", status: "deleted" },
      { path: "slides/02.slide.md", status: "modified" },
      { path: "slides/03.slide.md", status: "added" },
    ]);
  });

  it("a staged-only change counts too", async () => {
    const workspace = await folderWorkspace();
    initRepo(workspace);
    gitAs(workspace, "add", "-A");
    gitAs(workspace, "commit", "-q", "-m", "first");
    await write(workspace, { "talk/slides/01.slide.md": "# Staged\n" });
    git(workspace, "add", "talk/slides/01.slide.md");
    expect((await service().state(await deck(workspace, "talk"))).changes).toEqual([
      { path: "slides/01.slide.md", status: "modified" },
    ]);
  });

  it("a detached HEAD is ready and marked detached", async () => {
    const workspace = await folderWorkspace();
    initRepo(workspace);
    gitAs(workspace, "add", "-A");
    gitAs(workspace, "commit", "-q", "-m", "first");
    git(workspace, "checkout", "-q", "--detach");
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "ready",
      detached: true,
      head: { note: "first" },
    });
  });

  it("a repo above the workspace is used, and repoRoot names it", async () => {
    const outer = await tempDir("studio-hist-outer-");
    const workspace = path.join(outer, "work", "decks");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(outer);
    const state = await service().state(await deck(workspace, "talk"));
    expect(state).toMatchObject({ state: "ready", repoRoot: outer });
    expect(state.changes.map((change) => change.path)).toContain("presentation.yml");
  });

  it("handles Unicode, spaces and glob characters in names", async () => {
    const workspace = await tempDir("studio-hist-names-");
    const name = "Déjà vu [talk] *";
    await write(path.join(workspace, name), {
      "presentation.yml": "title: Déjà vu\nslides:\n  - slides/01 café ☕.slide.md\n",
      "slides/01 café ☕.slide.md": "# Café\n",
    });
    await write(workspace, { "Déjà vu [talk] x/presentation.yml": "title: Not me\nslides: []\n" });
    initRepo(workspace);
    const talk = await deck(workspace, name);
    const state = await service().state(talk);
    expect(state.changes).toEqual([
      { path: "presentation.yml", status: "added" },
      { path: "slides/01 café ☕.slide.md", status: "added" },
    ]);
    gitAs(workspace, "add", "-A");
    gitAs(workspace, "commit", "-q", "-m", "Café ☕ – first");
    const after = await service().state(talk);
    expect(after).toMatchObject({ dirty: false, head: { note: "Café ☕ – first", slidesChanged: 1 } });
  });

  it("parses porcelain -z status, including newlines in names", () => {
    const out = Buffer.from(
      [
        "?? deck/new\nline.md",
        " M deck/a b.md",
        "D  deck/gone.md",
        "A  deck/staged.md",
        "MM deck/both.md",
        "",
      ].join("\0"),
    );
    expect(parseStatus(out, "deck/")).toEqual([
      { path: "a b.md", status: "modified" },
      { path: "both.md", status: "modified" },
      { path: "gone.md", status: "deleted" },
      { path: "new\nline.md", status: "added" },
      { path: "staged.md", status: "added" },
    ]);
  });
});

describe("unsupported repositories", () => {
  it("a gitignored deck", async () => {
    const workspace = await folderWorkspace();
    await write(workspace, { ".gitignore": "talk/\n" });
    initRepo(workspace);
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "unsupported",
      reason: expect.stringMatching(/ignored/),
      repoRoot: workspace,
    });
  });

  it("a deck inside a submodule", async () => {
    const root = await tempDir("studio-hist-sub-");
    const inner = path.join(root, "inner");
    await write(path.join(inner, "talk"), FOLDER_DECK);
    initRepo(inner);
    gitAs(inner, "add", "-A");
    gitAs(inner, "commit", "-q", "-m", "inner");
    const outer = path.join(root, "outer");
    initRepo(outer);
    gitAs(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "ws");
    const workspace = path.join(outer, "ws");
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "unsupported",
      reason: expect.stringMatching(/submodule/),
    });
  });

  it("a deck stored with Git LFS", async () => {
    const workspace = await folderWorkspace();
    await write(workspace, { ".gitattributes": "*.slide.md filter=lfs diff=lfs merge=lfs -text\n" });
    initRepo(workspace);
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "unsupported",
      reason: expect.stringMatching(/talk\/slides\/01\.slide\.md is stored with Git LFS/),
    });
  });

  it("a deck inside a bare repository", async () => {
    const bare = await tempDir("studio-hist-bare-");
    git(bare, "init", "-q", "--bare");
    const workspace = path.join(bare, "ws");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    expect(await service().state(await deck(workspace, "talk"))).toMatchObject({
      state: "unsupported",
      reason: expect.stringMatching(/bare repository/),
    });
  });

  it("a repository git refuses to open (safe.directory)", async () => {
    const workspace = await folderWorkspace();
    initRepo(workspace);
    // Ownership can't be faked without root, so a wrapper gives git's own refusal message.
    const dir = fakeGit(
      [
        'case "$*" in',
        `  *rev-parse*) echo "fatal: detected dubious ownership in repository at '${workspace}'" >&2; echo "To add an exception for this directory, call: git config --global --add safe.directory ${workspace}" >&2; exit 128;;`,
        "esac",
        `exec "${realGit}" "$@"`,
      ].join("\n"),
    );
    const state = await service(runner({ env: { PATH: `${dir}:/usr/bin:/bin` } })).state(
      await deck(workspace, "talk"),
    );
    expect(state).toMatchObject({ state: "unsupported", reason: expect.stringMatching(/safe\.directory/) });
  });
});

describe("deck path spec", () => {
  it("a folder deck is its folder minus dist, exports, node_modules and the temp folder", async () => {
    const workspace = await folderWorkspace();
    initRepo(workspace);
    expect(await deckPathspec(await deck(workspace, "talk"), runner())).toEqual([
      ":(top,literal)talk",
      ":(top,exclude,glob)talk/**/.flipbook-studio-tmp/**",
      ":(top,exclude,glob)talk/**/dist/**",
      ":(top,exclude,glob)talk/**/exports/**",
      ":(top,exclude,glob)talk/**/node_modules/**",
    ]);
  });

  it("a deck that is the repository root uses the whole tree", async () => {
    const workspace = await folderWorkspace();
    initRepo(path.join(workspace, "talk"));
    expect((await deckPathspec(await deck(workspace, "talk"), runner()))![0]).toBe(":(top)");
  });

  it("a single-file deck is its file plus the shared assets it references", async () => {
    const workspace = await tempDir("studio-hist-single-");
    await write(workspace, {
      "a.slide.md":
        "---\ntitle: A\n---\n# One\n\n![x](assets/used.svg)\n\n---\n\n# Two\n\n![y](assets/gone.svg)\n",
      "b.slide.md": "---\ntitle: B\n---\n# B\n\n![z](assets/other.svg)\n",
      "assets/used.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "assets/other.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    initRepo(workspace);
    // gone.svg doesn't exist and isn't tracked, so it can't be in the spec (git would refuse it).
    expect(await deckPathspec(await deck(workspace, "a.slide.md"), runner())).toEqual([
      ":(top,literal)a.slide.md",
      ":(top,literal)assets/used.svg",
    ]);
    expect(
      await deckPathspec(await deck(workspace, "a.slide.md"), runner({ env: { PATH: "/nonexistent" } })),
    ).toBeNull();
  });
});
