import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRunner } from "../src/server/history/git.js";
import { SettingsStore } from "../src/server/settings.js";
import { encodeDeckId } from "../src/server/paths.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";
import { GLOBAL_GIT_CONFIG, git, gitAs, initRepo, runner } from "./support/git.js";

// US-23: Save version and git init through the API, on real temporary repositories.

const TALK = encodeDeckId("talk");

async function studio(workspace: string, git: GitRunner = runner()) {
  const settings = await SettingsStore.open(await tempDir("studio-hist-settings-"), () => {});
  const app = await makeApp(workspace, [], { git, settings });
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    app,
    settings,
    call,
    save: (note?: string, id = TALK) =>
      call("POST", `/api/decks/${id}/versions`, note === undefined ? {} : { note }),
  };
}

async function repoWithDeck({ author = true } = {}) {
  const workspace = await tempDir("studio-save-");
  await write(path.join(workspace, "talk"), FOLDER_DECK);
  initRepo(workspace, { author });
  return workspace;
}

const commitFiles = (repo: string, rev = "HEAD") =>
  git(repo, "show", "--name-only", "--format=", "-z", rev).split("\0").filter(Boolean).sort();
const subjects = (repo: string) => git(repo, "log", "--format=%s").trim().split("\n");

let realGlobal: string | null;
const realGlobalPath = path.join(os.homedir(), ".gitconfig");
beforeAll(async () => {
  realGlobal = await fs.readFile(realGlobalPath, "utf8").catch(() => null);
});
afterAll(async () => {
  // Studio never writes git config: neither the test's global file nor the real one changed.
  await expect(fs.access(GLOBAL_GIT_CONFIG)).rejects.toThrow();
  expect(await fs.readFile(realGlobalPath, "utf8").catch(() => null)).toBe(realGlobal);
});

describe("POST /api/decks/:id/versions", () => {
  it("commits only the deck; staged and unstaged work outside it stays byte-identical", async () => {
    const workspace = await repoWithDeck();
    await write(workspace, { "tracked.txt": "v1\n", "partly.txt": "base\n" });
    gitAs(workspace, "add", "tracked.txt", "partly.txt");
    gitAs(workspace, "commit", "-q", "-m", "outside");
    // Staged, unstaged, partly staged and untracked changes outside the deck.
    await write(workspace, {
      "staged.txt": "staged\n",
      "tracked.txt": "unstaged edit\n",
      "partly.txt": "staged part\n",
    });
    git(workspace, "add", "staged.txt", "partly.txt");
    await write(workspace, { "partly.txt": "staged part\nplus unstaged\n", "untracked.txt": "u\n" });
    await write(workspace, { "talk/dist/build.html": "x", "talk/node_modules/m/i.js": "x" });

    const before = {
      cached: git(workspace, "diff", "--cached", "--binary"),
      worktree: git(workspace, "diff", "--binary"),
      status: git(
        workspace,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude)talk",
      ),
      index: await fs.readFile(path.join(workspace, "partly.txt")),
    };
    const { save } = await studio(workspace);
    const saved = await save("first draft");
    expect(saved.status).toBe(201);
    expect(saved.body.version).toMatchObject({
      note: "first draft",
      author: "Test Author",
      slidesChanged: 2,
    });
    expect(saved.body.history).toMatchObject({ state: "ready", dirty: false, changes: [] });
    expect(saved.body.history.head.sha).toBe(git(workspace, "rev-parse", "HEAD").trim());
    expect(commitFiles(workspace)).toEqual([
      "talk/assets/logo.svg",
      "talk/presentation.yml",
      "talk/slides/01.slide.md",
      "talk/slides/02.slide.md",
    ]);
    expect(git(workspace, "diff", "--cached", "--binary")).toBe(before.cached);
    expect(git(workspace, "diff", "--binary")).toBe(before.worktree);
    expect(
      git(workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude)talk"),
    ).toBe(before.status);
    expect(await fs.readFile(path.join(workspace, "partly.txt"))).toEqual(before.index);
    // dist and node_modules inside the deck are never committed.
    expect(git(workspace, "ls-files", "talk")).not.toMatch(/dist|node_modules/);
  });

  it("an empty note becomes 'Save version of \"<title>\"'", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    expect((await save("   ")).body.version.note).toBe('Save version of "Folder deck"');
  });

  it("a note starting with - is only a note, sent on stdin", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    await save("first");
    await write(workspace, { "talk/slides/01.slide.md": "# Changed\n" });
    const saved = await save("--amend -n --no-verify");
    expect(saved.status).toBe(201);
    expect(subjects(workspace)).toEqual(["--amend -n --no-verify", "first"]);
  });

  it("a note starting with # isn't stripped as a comment", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    expect((await save("#1 draft")).body.version.note).toBe("#1 draft");
  });

  it("rejects a note over 200 characters or on two lines", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    expect((await save("x".repeat(201))).status).toBe(422);
    expect((await save("one\ntwo")).body.error.code).toBe("VALIDATION_FAILED");
    expect(git(workspace, "log", "--oneline", "--all")).toBe("");
  });

  it("nothing changed → 409 NO_CHANGES", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    await save("first");
    const again = await save("again");
    expect(again).toMatchObject({ status: 409, body: { error: { code: "NO_CHANGES" } } });
    expect(subjects(workspace)).toEqual(["first"]);
  });

  it("a single-file deck commits its file and only the shared assets it references", async () => {
    const workspace = await tempDir("studio-save-single-");
    await write(workspace, {
      "a.slide.md": "---\ntitle: A\n---\n# One\n\n![x](assets/used.svg)\n",
      "b.slide.md": "---\ntitle: B\n---\n# B\n\n![z](assets/other.svg)\n",
      "assets/used.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "assets/other.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    initRepo(workspace);
    const { save } = await studio(workspace);
    const saved = await save("single", encodeDeckId("a.slide.md"));
    expect(saved.status).toBe(201);
    expect(saved.body.version.slidesChanged).toBe(1);
    expect(commitFiles(workspace)).toEqual(["a.slide.md", "assets/used.svg"]);
    expect(git(workspace, "status", "--porcelain")).toContain("?? assets/other.svg");
  });

  it("a single-file deck commits the deletion of a tracked image it still references", async () => {
    const workspace = await tempDir("studio-save-gone-");
    await write(workspace, {
      "a.slide.md": "---\ntitle: A\n---\n# One\n\n![x](assets/used.svg)\n",
      "assets/used.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    initRepo(workspace);
    const { save } = await studio(workspace);
    expect((await save("first", encodeDeckId("a.slide.md"))).status).toBe(201);
    await fs.rm(path.join(workspace, "assets/used.svg"));
    const saved = await save("image gone", encodeDeckId("a.slide.md"));
    expect(saved.status).toBe(201);
    expect(git(workspace, "show", "--name-status", "--format=", "HEAD")).toBe("D\tassets/used.svg\n");
  });

  it("not in a repo → 409 GIT_NOT_A_REPO, and nothing is created", async () => {
    const workspace = await tempDir("studio-save-norepo-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    const { save } = await studio(workspace);
    expect(await save("x")).toMatchObject({ status: 409, body: { error: { code: "GIT_NOT_A_REPO" } } });
    await expect(fs.access(path.join(workspace, ".git"))).rejects.toThrow();
  });

  it("git missing → 503 GIT_NOT_INSTALLED for save and init", async () => {
    const workspace = await repoWithDeck();
    const { save, call } = await studio(workspace, runner({ env: { PATH: await tempDir("studio-empty-") } }));
    expect(await save("x")).toMatchObject({ status: 503, body: { error: { code: "GIT_NOT_INSTALLED" } } });
    expect(await call("POST", "/api/git/init", { deckId: TALK, at: "deck" })).toMatchObject({
      status: 503,
      body: { error: { code: "GIT_NOT_INSTALLED" } },
    });
    const listed = await call("GET", `/api/decks/${TALK}/versions`);
    expect(listed).toMatchObject({
      status: 200,
      body: { history: { state: "no-git" }, versions: [], next: null },
    });
  });

  it("no author anywhere → 409 GIT_AUTHOR_MISSING; the saved author is used through -c only", async () => {
    const workspace = await repoWithDeck({ author: false });
    const { save, call } = await studio(workspace);
    expect(await save("x")).toMatchObject({ status: 409, body: { error: { code: "GIT_AUTHOR_MISSING" } } });
    expect(git(workspace, "log", "--oneline", "--all")).toBe("");

    const invalid = await call("PUT", "/api/settings", { git: { author: { name: "Ada", email: "nope" } } });
    expect(invalid.status).toBe(422);
    const put = await call("PUT", "/api/settings", {
      git: { author: { name: "Ada Lovelace", email: "ada@example.com" } },
    });
    expect(put).toMatchObject({ status: 200, body: { git: { author: { name: "Ada Lovelace" } } } });
    const saved = await save("by Ada");
    expect(saved.status).toBe(201);
    expect(git(workspace, "log", "-1", "--format=%an <%ae> / %cn <%ce>")).toBe(
      "Ada Lovelace <ada@example.com> / Ada Lovelace <ada@example.com>\n",
    );
    // The repo's config is untouched.
    expect(git(workspace, "config", "--local", "--list")).not.toMatch(/user\./);
    // author: null forgets it; other settings stay.
    const cleared = await call("PUT", "/api/settings", { git: { author: null } });
    expect(cleared.body).toMatchObject({ version: 1, llm: null });
    expect(cleared.body.git).toBeUndefined();
  });

  it("git config's own author wins over the saved one", async () => {
    const workspace = await repoWithDeck();
    const { save, call } = await studio(workspace);
    await call("PUT", "/api/settings", {
      git: { author: { name: "Studio Name", email: "studio@example.com" } },
    });
    await save("mine");
    expect(git(workspace, "log", "-1", "--format=%an")).toBe("Test Author\n");
  });

  it("index.lock or a merge in progress → 409 GIT_BUSY", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    await fs.writeFile(path.join(workspace, ".git", "index.lock"), "");
    const locked = await save("x");
    expect(locked).toMatchObject({ status: 409, body: { error: { code: "GIT_BUSY" } } });
    expect(locked.body.error.message).toBe(
      `Git is busy in ${workspace} (index.lock exists). Finish it, then try again.`,
    );
    await fs.rm(path.join(workspace, ".git", "index.lock"));
    await fs.writeFile(path.join(workspace, ".git", "MERGE_HEAD"), "0".repeat(40));
    expect((await save("x")).body.error.message).toMatch(/a merge is in progress/);
  });

  it("a failing pre-commit hook → 422 GIT_COMMIT_FAILED with the last 4 kB of output", async () => {
    const workspace = await repoWithDeck();
    const hook = path.join(workspace, ".git", "hooks", "pre-commit");
    await fs.writeFile(
      hook,
      '#!/bin/sh\ni=0; while [ $i -lt 300 ]; do echo "lint noise $i"; i=$((i+1)); done\necho "pre-commit: slides need a review" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const { save } = await studio(workspace);
    const failed = await save("x");
    expect(failed).toMatchObject({ status: 422, body: { error: { code: "GIT_COMMIT_FAILED" } } });
    const output = failed.body.error.details.output as string;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096);
    expect(output).toContain("pre-commit: slides need a review");
    expect(output).not.toContain("lint noise 0\n");
    expect(git(workspace, "log", "--oneline", "--all")).toBe("");
  });

  it("a hook that hangs → 504 GIT_TIMEOUT", async () => {
    const workspace = await repoWithDeck();
    await fs.writeFile(
      path.join(workspace, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho waiting for pinentry\nsleep 30\n",
      {
        mode: 0o755,
      },
    );
    const { save } = await studio(workspace, runner({ timeoutMs: 1500 }));
    const timedOut = await save("x");
    expect(timedOut).toMatchObject({ status: 504, body: { error: { code: "GIT_TIMEOUT" } } });
    expect(timedOut.body.error.details.output).toContain("waiting for pinentry");
  });

  it("hooks run as they would for the user's own git", async () => {
    const workspace = await repoWithDeck();
    const marker = path.join(workspace, "hook-ran");
    await fs.writeFile(
      path.join(workspace, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch "${marker}"\n`,
      { mode: 0o755 },
    );
    const { save } = await studio(workspace);
    expect((await save("x")).status).toBe(201);
    await fs.access(marker);
  });

  it("a commit on a detached HEAD works and stays detached", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    await save("first");
    git(workspace, "checkout", "-q", "--detach");
    await write(workspace, { "talk/slides/02.slide.md": "# Detached\n" });
    const saved = await save("on detached");
    expect(saved.body.history).toMatchObject({ detached: true, head: { note: "on detached" } });
    expect(git(workspace, "log", "-1", "--format=%s", "main")).toBe("first\n");
  });

  it("an unsupported deck can't be saved", async () => {
    const workspace = await repoWithDeck();
    await write(workspace, { ".gitignore": "talk/\n" });
    const { save } = await studio(workspace);
    expect(await save("x")).toMatchObject({ status: 409, body: { error: { code: "GIT_NOT_A_REPO" } } });
  });

  it("an unknown deck → 404", async () => {
    const workspace = await repoWithDeck();
    const { save } = await studio(workspace);
    expect((await save("x", encodeDeckId("nope"))).status).toBe(404);
  });
});

describe("POST /api/git/init", () => {
  it("inits at the deck folder, with no commit", async () => {
    const workspace = await tempDir("studio-init-deck-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    const { call } = await studio(workspace);
    const init = await call("POST", "/api/git/init", { deckId: TALK, at: "deck" });
    expect(init).toMatchObject({
      status: 201,
      body: { history: { state: "ready", repoRoot: path.join(workspace, "talk"), head: null, dirty: true } },
    });
    await fs.access(path.join(workspace, "talk", ".git"));
    await expect(fs.access(path.join(workspace, ".git"))).rejects.toThrow();
    expect(() => git(path.join(workspace, "talk"), "rev-parse", "--verify", "-q", "HEAD")).toThrow();
  });

  it("inits at the workspace, with no commit", async () => {
    const workspace = await tempDir("studio-init-ws-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    const { call } = await studio(workspace);
    const init = await call("POST", "/api/git/init", { deckId: TALK, at: "workspace" });
    expect(init).toMatchObject({ status: 201, body: { history: { state: "ready", repoRoot: workspace } } });
    await fs.access(path.join(workspace, ".git"));
    expect(git(workspace, "status", "--porcelain")).toContain("?? talk/");
  });

  it("where a repo exists → 409 GIT_ALREADY_A_REPO", async () => {
    const workspace = await repoWithDeck();
    const { call } = await studio(workspace);
    expect(await call("POST", "/api/git/init", { deckId: TALK, at: "deck" })).toMatchObject({
      status: 409,
      body: { error: { code: "GIT_ALREADY_A_REPO" } },
    });
    await expect(fs.access(path.join(workspace, "talk", ".git"))).rejects.toThrow();
  });

  it("validates the request", async () => {
    const workspace = await repoWithDeck();
    const { call } = await studio(workspace);
    expect((await call("POST", "/api/git/init", { deckId: TALK, at: "home" })).status).toBe(422);
  });

  it("init then save, end to end through the API", async () => {
    const workspace = await tempDir("studio-init-save-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    const { call, save } = await studio(workspace);
    await call("POST", "/api/git/init", { deckId: TALK, at: "deck" });
    // No author in this repo's config or the (empty) global one.
    expect((await save("first")).body.error.code).toBe("GIT_AUTHOR_MISSING");
    await call("PUT", "/api/settings", { git: { author: { name: "A", email: "a@example.com" } } });
    expect((await save("first")).status).toBe(201);
    expect(subjects(path.join(workspace, "talk"))).toEqual(["first"]);
  });
});
