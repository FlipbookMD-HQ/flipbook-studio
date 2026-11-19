import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { encodeDeckId } from "../src/server/paths.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";
import { git, gitAs, initRepo, runner } from "./support/git.js";

// US-23: the timeline (GET /api/decks/:id/versions): paging, outside commits, slidesChanged.

const TALK = encodeDeckId("talk");
const SOLO = encodeDeckId("solo.slide.md");

async function studio(workspace: string) {
  const settings = await SettingsStore.open(await tempDir("studio-tl-settings-"), () => {});
  const app = await makeApp(workspace, [], { git: runner(), settings });
  return async (url: string, method = "GET", body?: unknown) => {
    const response = await app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

const commit = (repo: string, note: string) => {
  gitAs(repo, "add", "-A");
  gitAs(repo, "commit", "-q", "--allow-empty", "-m", note);
};

describe("GET /api/decks/:id/versions", () => {
  it("pages through 45 versions newest first; next is null on the last page", async () => {
    const workspace = await tempDir("studio-tl-page-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(workspace);
    for (let index = 1; index <= 45; index += 1) {
      await write(workspace, { "talk/slides/01.slide.md": `# First v${index}\n` });
      commit(workspace, `v${index}`);
    }
    const call = await studio(workspace);
    const notes: string[] = [];
    let before: string | null = null;
    const sizes: number[] = [];
    do {
      const page = await call(`/api/decks/${TALK}/versions${before ? `?before=${before}` : ""}`);
      expect(page.status).toBe(200);
      sizes.push(page.body.versions.length);
      notes.push(...page.body.versions.map((version: { note: string }) => version.note));
      before = page.body.next;
    } while (before);
    expect(sizes).toEqual([20, 20, 5]);
    expect(notes).toEqual(Array.from({ length: 45 }, (_, index) => `v${45 - index}`));

    const small = await call(`/api/decks/${TALK}/versions?limit=45`);
    expect(small.body.versions).toHaveLength(45);
    expect(small.body.next).toBeNull();
    const fifty = await call(`/api/decks/${TALK}/versions?limit=50`);
    expect(fifty.body.next).toBeNull();
    const one = await call(`/api/decks/${TALK}/versions?limit=1`);
    expect(one.body).toMatchObject({ versions: [{ note: "v45", author: "Outside", slidesChanged: 1 }] });
    expect(one.body.next).toBe(one.body.versions[0].sha);
    expect(one.body.history).toMatchObject({ state: "ready", head: { note: "v45" }, dirty: false });
    expect(new Date(one.body.versions[0].time).toISOString()).toBe(one.body.versions[0].time);
  });

  it("lists commits made outside Studio that touch the deck, and skips the others", async () => {
    const workspace = await tempDir("studio-tl-outside-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(workspace);
    commit(workspace, "outside: first");
    await write(workspace, { "README.md": "unrelated\n" });
    commit(workspace, "outside: readme only");
    await write(workspace, { "talk/dist/x.html": "build" });
    commit(workspace, "outside: build output only");
    const call = await studio(workspace);
    await write(workspace, { "talk/slides/02.slide.md": "# Second, again\n" });
    expect((await call(`/api/decks/${TALK}/versions`, "POST", { note: "from Studio" })).status).toBe(201);
    await write(workspace, {
      "talk/presentation.yml": "title: Renamed\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n",
    });
    commit(workspace, "outside: retitle");

    const page = await call(`/api/decks/${TALK}/versions`);
    expect(
      page.body.versions.map((version: { note: string; author: string }) => [version.note, version.author]),
    ).toEqual([
      ["outside: retitle", "Outside"],
      ["from Studio", "Test Author"],
      ["outside: first", "Outside"],
    ]);
  });

  it("slidesChanged counts slide files added, removed and modified in a folder deck", async () => {
    const workspace = await tempDir("studio-tl-folder-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(workspace);
    commit(workspace, "start");
    await write(workspace, {
      "talk/presentation.yml":
        "title: Folder deck\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n  - slides/03.slide.md\n",
      "talk/slides/03.slide.md": "# Third\n",
    });
    commit(workspace, "add one");
    await write(workspace, { "talk/slides/01.slide.md": "# One!\n", "talk/slides/02.slide.md": "# Two!\n" });
    commit(workspace, "modify two");
    await fs.rm(path.join(workspace, "talk/slides/03.slide.md"));
    await write(workspace, { "talk/presentation.yml": FOLDER_DECK["presentation.yml"] });
    commit(workspace, "remove one");
    await write(workspace, {
      "talk/presentation.yml":
        "title: Only the title\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n",
    });
    commit(workspace, "manifest only");
    git(workspace, "mv", "talk/slides/02.slide.md", "talk/slides/02b.slide.md");
    await write(workspace, {
      "talk/presentation.yml":
        "title: Only the title\nslides:\n  - slides/01.slide.md\n  - slides/02b.slide.md\n",
    });
    commit(workspace, "rename");

    const call = await studio(workspace);
    const page = await call(`/api/decks/${TALK}/versions`);
    expect(
      page.body.versions.map((version: { note: string; slidesChanged: number }) => [
        version.note,
        version.slidesChanged,
      ]),
    ).toEqual([
      ["rename", 2],
      ["manifest only", 0],
      ["remove one", 1],
      ["modify two", 2],
      ["add one", 1],
      ["start", 2],
    ]);
    // Cached by sha: a second read gives the same answer.
    expect((await call(`/api/decks/${TALK}/versions`)).body.versions).toEqual(page.body.versions);
  });

  it("slidesChanged compares a single-file deck's slides by position", async () => {
    const workspace = await tempDir("studio-tl-single-");
    const deck = (...slides: string[]) => `---\ntitle: Solo\n---\n${slides.join("\n\n---\n\n")}\n`;
    await write(workspace, { "solo.slide.md": deck("# A", "# B") });
    initRepo(workspace);
    commit(workspace, "start");
    await write(workspace, { "solo.slide.md": deck("# A", "# B", "# C") });
    commit(workspace, "add");
    await write(workspace, { "solo.slide.md": deck("# A", "# B changed", "# C") });
    commit(workspace, "modify");
    await write(workspace, { "solo.slide.md": deck("# A", "# B changed") });
    commit(workspace, "remove");
    await write(workspace, { "solo.slide.md": deck("# B changed", "# A") });
    commit(workspace, "swap");
    await write(workspace, {
      "solo.slide.md": `---\ntitle: Solo retitled\n---\n# B changed\n\n---\n\n# A\n`,
    });
    commit(workspace, "frontmatter only");

    const call = await studio(workspace);
    const page = await call(`/api/decks/${SOLO}/versions`);
    expect(
      page.body.versions.map((version: { note: string; slidesChanged: number }) => [
        version.note,
        version.slidesChanged,
      ]),
    ).toEqual([
      ["frontmatter only", 0],
      ["swap", 2],
      ["remove", 1],
      ["modify", 1],
      ["add", 1],
      ["start", 2],
    ]);
  });

  it("an empty repo and a deck with no repo list nothing", async () => {
    const workspace = await tempDir("studio-tl-empty-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    const call = await studio(workspace);
    expect((await call(`/api/decks/${TALK}/versions`)).body).toMatchObject({
      history: { state: "no-repo" },
      versions: [],
      next: null,
    });
    initRepo(workspace);
    expect((await call(`/api/decks/${TALK}/versions`)).body).toMatchObject({
      history: { state: "ready", head: null },
      versions: [],
      next: null,
    });
  });

  it("checks before and limit", async () => {
    const workspace = await tempDir("studio-tl-query-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(workspace);
    commit(workspace, "start");
    await write(workspace, { "other.txt": "x" });
    commit(workspace, "not the deck");
    const call = await studio(workspace);
    expect((await call(`/api/decks/${TALK}/versions?before=--all`)).status).toBe(422);
    expect((await call(`/api/decks/${TALK}/versions?before=HEAD`)).status).toBe(422);
    expect((await call(`/api/decks/${TALK}/versions?limit=0`)).status).toBe(422);
    expect((await call(`/api/decks/${TALK}/versions?limit=51`)).status).toBe(422);
    expect((await call(`/api/decks/${TALK}/versions?before=${"a".repeat(40)}`)).body.error.code).toBe(
      "VERSION_NOT_FOUND",
    );
    const outside = git(workspace, "rev-parse", "HEAD").trim();
    expect((await call(`/api/decks/${TALK}/versions?before=${outside}`)).body.error.code).toBe(
      "VERSION_NOT_FOUND",
    );
    expect((await call(`/api/decks/${encodeDeckId("nope")}/versions`)).status).toBe(404);
  });
});
