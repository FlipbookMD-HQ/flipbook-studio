import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { encodeDeckId } from "../src/server/paths.js";
import { MAX_VERSION_COPIES, copyKey } from "../src/server/history/copies.js";
import { TMP_DIR } from "../src/server/workspace.js";
import { FOLDER_DECK, PORT, headers, makeApp, tempDir, write } from "./helpers.js";
import { git, gitAs, initRepo, runner } from "./support/git.js";

// US-27 · 1.1.1.2: the version view (GET …/versions/:sha), slide previews and the version
// files/* route, on real temporary repositories with an isolated git config.

const TALK = encodeDeckId("talk");
const SOLO = encodeDeckId("solo.slide.md");

async function studio(workspace: string) {
  const settings = await SettingsStore.open(await tempDir("studio-view-settings-"), () => {});
  const app = await makeApp(workspace, [], { git: runner(), settings });
  const get = async (url: string, extra: Record<string, string | null> = {}) => {
    const response = await app.request(url, { headers: headers(extra) });
    const type = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes("json") ? await response.json() : await response.text(),
    };
  };
  return {
    app,
    get,
    view: (sha: string, id = TALK) => get(`/api/decks/${id}/versions/${sha}`),
    preview: (sha: string, slideId: string, id = TALK) =>
      get(`/api/decks/${id}/versions/${sha}/slides/${encodeURIComponent(slideId)}/preview`),
    file: (sha: string, rest: string, id = TALK, extra: Record<string, string | null> = {}) =>
      get(`/api/decks/${id}/versions/${sha}/files/${rest}`, { "x-flipbook-token": null, ...extra }),
  };
}

const commit = (repo: string, note: string) => {
  gitAs(repo, "add", "-A");
  gitAs(repo, "commit", "-q", "-m", note);
  return git(repo, "rev-parse", "HEAD").trim();
};

const gitState = async (repo: string) => ({
  head: git(repo, "rev-parse", "HEAD").trim(),
  refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
  index: (await fs.readFile(path.join(repo, ".git/index"))).toString("base64"),
  count: git(repo, "rev-list", "--count", "--all").trim(),
});

const THREE = {
  ...FOLDER_DECK,
  "presentation.yml":
    'title: Folder deck\nslides:\n  - "slides/01.slide.md"\n  - "slides/02.slide.md"\n  - "slides/03.slide.md"\n',
  "slides/03.slide.md": "# Third\n",
};

/** v1: a three-slide folder deck. Now: slide 01 edited, slide 02 deleted, slide 03 untouched. */
async function folderDeck() {
  const workspace = await tempDir("studio-view-");
  await write(path.join(workspace, "talk"), THREE);
  initRepo(workspace);
  const v1 = commit(workspace, "v1");
  const deckDir = path.join(workspace, "talk");
  await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), "# First, edited\n");
  await fs.rm(path.join(deckDir, "slides/02.slide.md"));
  await fs.writeFile(
    path.join(deckDir, "presentation.yml"),
    'title: Folder deck\nslides:\n  - "slides/01.slide.md"\n  - "slides/03.slide.md"\n',
  );
  return { workspace, deckDir, v1 };
}

const SOLO_V1 = "---\ntitle: Solo\n---\n# One\n\nHello.\n\n---\n\n# Two\n\nWorld.\n\n---\n\n# Three\n";

describe("GET /api/decks/:id/versions/:sha", () => {
  it("lists a folder deck's slides at that version, matched by file name, with no git changes", async () => {
    const { workspace, v1 } = await folderDeck();
    const before = await gitState(workspace);
    const { view } = await studio(workspace);
    const response = await view(v1);
    expect(response.status).toBe(200);
    expect(response.body.version).toMatchObject({ sha: v1, note: "v1", author: "Outside" });
    expect(response.body.slides).toEqual([
      { slideId: "slides/01.slide.md", index: 0, title: "First", template: "flow", status: "changed" },
      { slideId: "slides/02.slide.md", index: 1, title: "Second", template: "flow", status: "gone" },
      { slideId: "slides/03.slide.md", index: 2, title: "Third", template: "flow", status: "same" },
    ]);
    expect(await gitState(workspace)).toEqual(before);
  });

  it("marks a slide whose image is missing now as changed", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.writeFile(path.join(deckDir, "slides/01.slide.md"), THREE["slides/01.slide.md"]);
    const { view } = await studio(workspace);
    expect((await view(v1)).body.slides[0].status).toBe("same");
    await fs.rm(path.join(deckDir, "assets/logo.svg"));
    expect((await view(v1)).body.slides[0].status).toBe("changed");
  });

  it("matches a single-file deck's slides by position", async () => {
    const workspace = await tempDir("studio-view-solo-");
    await write(workspace, { "solo.slide.md": SOLO_V1 });
    initRepo(workspace);
    const v1 = commit(workspace, "v1");
    await fs.writeFile(
      path.join(workspace, "solo.slide.md"),
      "---\ntitle: Solo\n---\n# One\n\nHello.\n\n---\n\n# Two, edited\n",
    );
    const { view } = await studio(workspace);
    const response = await view(v1, SOLO);
    expect(response.status).toBe(200);
    expect(
      response.body.slides.map((slide: { slideId: string; status: string }) => [slide.slideId, slide.status]),
    ).toEqual([
      ["#0", "same"],
      ["#1", "changed"],
      ["#2", "gone"],
    ]);
  });

  it("422 for a malformed sha, 404 VERSION_NOT_FOUND for one outside the deck's log", async () => {
    const { workspace, v1 } = await folderDeck();
    await write(workspace, { "other/presentation.yml": "title: Other\nslides:\n  - a.slide.md\n" });
    await write(workspace, { "other/a.slide.md": "# A\n" });
    gitAs(workspace, "add", "other");
    gitAs(workspace, "commit", "-q", "-m", "other deck only", "--", "other");
    const other = git(workspace, "rev-parse", "HEAD").trim();
    const { view } = await studio(workspace);
    expect((await view("HEAD")).status).toBe(422);
    expect((await view(`${v1.slice(0, 39)}`)).status).toBe(422);
    expect((await view("--output=x".padEnd(40, "0"))).status).toBe(422);
    const notInLog = await view(other);
    expect(notInLog.status).toBe(404);
    expect(notInLog.body.error.code).toBe("VERSION_NOT_FOUND");
    expect((await view("f".repeat(40))).body.error.code).toBe("VERSION_NOT_FOUND");
  });
});

describe("version slide previews and files", () => {
  it("renders a version's slide as HTML with the preview CSP and sandbox; images come from the version", async () => {
    const { workspace, deckDir, v1 } = await folderDeck();
    await fs.rm(path.join(deckDir, "assets/logo.svg"));
    const { preview, file } = await studio(workspace);
    const response = await preview(v1, "slides/02.slide.md");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'self'.*; sandbox$/);
    expect(response.body).toContain("Second");

    const first = await preview(v1, "slides/01.slide.md");
    expect(first.body).toContain(`src="/api/decks/${TALK}/versions/${v1}/files/assets/logo.svg"`);
    // The image is gone from the deck now, but the version still has it. No token needed.
    const logo = await file(v1, "assets/logo.svg");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect(logo.body).toBe(FOLDER_DECK["assets/logo.svg"]);
    expect((await file(v1, "assets/missing.svg")).status).toBe(404);
    expect((await preview(v1, "slides/09.slide.md")).status).toBe(404);
  });

  it("the files route refuses .., encoded escapes, absolute and hidden paths, and checks Host", async () => {
    const { workspace, v1 } = await folderDeck();
    await write(workspace, { "secret.txt": "secret" });
    const { file } = await studio(workspace);
    for (const attempt of [
      "..%2F..%2Fsecret.txt",
      "..%2f..%2f..%2fsecret.txt",
      "assets%2F..%2F..%2Fsecret.txt",
      "assets%2F..%2Fpresentation.yml",
      "%2Fetc%2Fpasswd",
      "assets%5C..%5C..%5Csecret.txt",
      "%2E%2E%2Fsecret.txt",
      ".git%2Fconfig",
      "assets/logo.svg%00.png",
    ]) {
      const response = await file(v1, attempt);
      expect(response.status, attempt).toBe(403);
      expect(response.body.error.code, attempt).toBe("PATH_OUTSIDE_ROOT");
    }
    // Plain `..` segments are folded by the URL parser and never reach the files route.
    const folded = await file(v1, "../../../secret.txt");
    expect(folded.status).not.toBe(200);
    // DNS rebinding: a foreign Host is refused before anything else.
    const foreign = await file(v1, "assets/logo.svg", TALK, { host: "evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await file("nothex", "assets/logo.svg")).status).toBe(422);
  });

  it("refuses writes to version files", async () => {
    const { workspace, v1 } = await folderDeck();
    const { app } = await studio(workspace);
    const response = await app.request(`/api/decks/${TALK}/versions/${v1}/files/assets/logo.svg`, {
      method: "PUT",
      headers: headers(),
      body: "x",
    });
    expect(response.status).toBe(403);
  });
});

describe("version copies", () => {
  it(`keeps at most ${MAX_VERSION_COPIES} copies in the temp folder and prunes the oldest`, async () => {
    const workspace = await tempDir("studio-view-prune-");
    await write(path.join(workspace, "talk"), FOLDER_DECK);
    initRepo(workspace);
    const shas: string[] = [];
    for (let n = 1; n <= MAX_VERSION_COPIES + 1; n += 1) {
      await fs.writeFile(path.join(workspace, "talk/slides/02.slide.md"), `# Second ${n}\n`);
      shas.push(commit(workspace, `v${n}`));
    }
    const { view } = await studio(workspace);
    const base = path.join(workspace, TMP_DIR, "versions");
    const copies = async () => (await fs.readdir(base)).filter((name) => !name.startsWith(".")).sort();
    const name = (sha: string) => `${copyKey({ relative: "talk", absolute: "", kind: "folder" })}-${sha}`;

    for (const sha of shas.slice(0, MAX_VERSION_COPIES)) expect((await view(sha)).status).toBe(200);
    expect(await copies()).toEqual(shas.slice(0, MAX_VERSION_COPIES).map(name).sort());
    // Using the first again makes the second the oldest.
    expect((await view(shas[0]!)).status).toBe(200);
    expect((await view(shas[MAX_VERSION_COPIES]!)).status).toBe(200);
    const kept = await copies();
    expect(kept).toHaveLength(MAX_VERSION_COPIES);
    expect(kept).not.toContain(name(shas[1]!));
    expect(kept).toContain(name(shas[0]!));
    expect(kept).toContain(name(shas[MAX_VERSION_COPIES]!));
    // A pruned version is copied again on demand, with the right content.
    const again = await view(shas[1]!);
    expect(again.status).toBe(200);
    expect(again.body.slides[1].title).toBe("Second 2");
    expect(await copies()).toHaveLength(MAX_VERSION_COPIES);
    // The deck's own files and scans never see the copies.
    expect(await fs.readdir(path.join(workspace, "talk"))).not.toContain(TMP_DIR);
  });

  it("the workspace scan ignores the version copies", async () => {
    const { workspace, v1 } = await folderDeck();
    const { view, get } = await studio(workspace);
    expect((await view(v1)).status).toBe(200);
    const scan = await get("/api/workspace");
    expect(scan.body.decks.map((deck: { path: string }) => deck.path)).toEqual(["talk"]);
    expect(PORT).toBeGreaterThan(0);
  });
});
