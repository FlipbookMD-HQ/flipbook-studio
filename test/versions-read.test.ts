import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findDeck } from "../src/server/decks.js";
import { readVersion } from "../src/server/history/restore.js";
import { encodeDeckId } from "../src/server/paths.js";
import { FOLDER_DECK, tempDir, write } from "./helpers.js";
import { git, gitAs, initRepo, runner } from "./support/git.js";

// US-26 · 1.1.1: readVersion (D42) on real temporary repositories.

const commit = (repo: string, note: string) => {
  gitAs(repo, "add", "-A");
  gitAs(repo, "commit", "-q", "-m", note);
  return git(repo, "rev-parse", "HEAD").trim();
};

async function folderRepo() {
  const workspace = await tempDir("studio-read-");
  await write(path.join(workspace, "talk"), FOLDER_DECK);
  initRepo(workspace);
  const v1 = commit(workspace, "v1");
  return { workspace, v1, deck: await findDeck(workspace, encodeDeckId("talk")) };
}

const text = (files: Map<string, Buffer>) =>
  Object.fromEntries([...files].map(([file, bytes]) => [file, bytes.toString("utf8")]));

describe("readVersion", () => {
  it("returns the deck's files at that version, keyed relative to the deck", async () => {
    const { workspace, v1, deck } = await folderRepo();
    await write(workspace, {
      "talk/slides/02.slide.md": "# Second, edited\n",
      "talk/slides/03.slide.md": "# Third\n",
      "elsewhere.txt": "not the deck\n",
    });
    commit(workspace, "v2");
    const head = git(workspace, "rev-parse", "HEAD").trim();
    const indexBefore = await fs.readFile(path.join(workspace, ".git/index"));

    const read = await readVersion(deck, v1, runner());
    expect(text(read.files)).toEqual(FOLDER_DECK);
    expect(read.skipped).toEqual([]);
    // Reading changes nothing: same HEAD, same index, same working tree.
    expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(head);
    expect(await fs.readFile(path.join(workspace, ".git/index"))).toEqual(indexBefore);
    expect(await fs.readFile(path.join(workspace, "talk/slides/03.slide.md"), "utf8")).toBe("# Third\n");
  });

  it("leaves out dist, exports and node_modules, like the deck's path spec", async () => {
    const { workspace, deck } = await folderRepo();
    await write(workspace, { "talk/dist/index.html": "built", "talk/node_modules/m/i.js": "x" });
    git(workspace, "add", "-f", "talk/dist", "talk/node_modules");
    gitAs(workspace, "commit", "-q", "-m", "built");
    await write(workspace, { "talk/slides/01.slide.md": "# First v2\n" });
    const v2 = commit(workspace, "v2");
    expect([...(await readVersion(deck, v2, runner())).files.keys()].sort()).toEqual(
      Object.keys(FOLDER_DECK).sort(),
    );
  });

  it("with core.autocrlf=true, the bytes equal a fresh checkout's", async () => {
    const { workspace, deck } = await folderRepo();
    git(workspace, "config", "core.autocrlf", "true");
    await write(workspace, { "talk/slides/02.slide.md": "# Second\r\n\r\nLine one.\r\nLine two.\r\n" });
    const v2 = commit(workspace, "crlf");
    // The repository stores LF; a checkout with autocrlf writes CRLF.
    expect(git(workspace, "cat-file", "-p", `${v2}:talk/slides/02.slide.md`)).not.toContain("\r");

    const clone = path.join(await tempDir("studio-read-clone-"), "c");
    git(path.dirname(clone), "clone", "-q", "-c", "core.autocrlf=true", workspace, clone);
    const read = await readVersion(deck, v2, runner());
    for (const file of ["slides/02.slide.md", "slides/01.slide.md", "presentation.yml"])
      expect(read.files.get(file)).toEqual(await fs.readFile(path.join(clone, "talk", file)));
    expect(read.files.get("slides/02.slide.md")!.toString("utf8")).toContain("\r\n");
  });

  it("skips symlink and submodule entries and says why", async () => {
    const { workspace, deck } = await folderRepo();
    await fs.symlink("../../../etc/passwd", path.join(workspace, "talk/assets/evil.svg"));
    gitAs(workspace, "add", "-A");
    const someCommit = git(workspace, "rev-parse", "HEAD").trim();
    git(workspace, "update-index", "--add", "--cacheinfo", `160000,${someCommit},talk/vendor`);
    gitAs(workspace, "commit", "-q", "-m", "links");
    const v2 = git(workspace, "rev-parse", "HEAD").trim();

    const read = await readVersion(deck, v2, runner());
    expect(read.skipped).toEqual([
      { path: "assets/evil.svg", reason: "symlink" },
      { path: "vendor", reason: "submodule" },
    ]);
    expect(read.files.has("assets/evil.svg")).toBe(false);
    expect(read.files.has("vendor")).toBe(false);
    expect(read.files.has("slides/01.slide.md")).toBe(true);
  });

  it("a single-file deck: its file plus the images in assets/ that version references", async () => {
    const workspace = await tempDir("studio-read-single-");
    await write(workspace, {
      "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n![a](assets/a.svg)\n",
      "assets/a.svg": "<svg/>",
      "assets/b.svg": "<svg>b</svg>",
      "other.slide.md": "---\ntitle: Other\n---\n# Other\n\n![b](assets/b.svg)\n",
    });
    initRepo(workspace);
    const v1 = commit(workspace, "v1");
    await write(workspace, { "solo.slide.md": "---\ntitle: Solo\n---\n# One\n" });
    commit(workspace, "v2");
    const deck = await findDeck(workspace, encodeDeckId("solo.slide.md"));
    const read = await readVersion(deck, v1, runner());
    expect(text(read.files)).toEqual({
      "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n![a](assets/a.svg)\n",
      "assets/a.svg": "<svg/>",
    });
  });

  it("404 VERSION_NOT_FOUND for a sha outside the deck's log", async () => {
    const { workspace, deck } = await folderRepo();
    await write(workspace, { "elsewhere.txt": "x\n" });
    const outside = commit(workspace, "not the deck");
    git(workspace, "checkout", "-q", "-b", "side");
    await write(workspace, { "talk/slides/01.slide.md": "# Side\n" });
    const side = commit(workspace, "on a side branch");
    git(workspace, "checkout", "-q", "main");
    const tree = git(workspace, "rev-parse", "HEAD^{tree}").trim();
    for (const sha of [outside, side, "f".repeat(40), tree])
      await expect(readVersion(deck, sha, runner())).rejects.toMatchObject({
        status: 404,
        code: "VERSION_NOT_FOUND",
      });
  });

  it("422 for a malformed sha, before git runs", async () => {
    const { deck } = await folderRepo();
    const git = runner();
    const run = vi.spyOn(git, "run");
    const check = vi.spyOn(git, "check");
    for (const sha of [
      "HEAD",
      "--output=/tmp/x",
      "abc123",
      "A".repeat(40),
      `${"a".repeat(40)} `,
      "a".repeat(41),
    ])
      await expect(readVersion(deck, sha, git)).rejects.toMatchObject({
        status: 422,
        code: "VALIDATION_FAILED",
      });
    expect(run).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});
