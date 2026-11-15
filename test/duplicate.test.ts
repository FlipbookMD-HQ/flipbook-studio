import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPresentation } from "@flipbook-md/core";
import { encodeDeckId } from "../src/server/paths.js";
import { DuplicateDeckResponseSchema } from "../src/shared/api.js";
import { FOLDER_DECK, SINGLE_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-20 · 2.1.1: POST /api/decks/:id/duplicate and POST /api/kits/:kind/:name/copy (D26, D27).

let home: string | undefined;
let library: string;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  library = await tempDir("studio-dup-home-");
  process.env.FLIPBOOK_HOME = library;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

const prefixed = (files: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(files).map(([name, body]) => [`${prefix}/${name}`, body]));

async function setup() {
  const root = await tempDir();
  await write(root, {
    ...prefixed(FOLDER_DECK, "talk"),
    "talk/dist/out.pdf": "x",
    "solo.slide.md": SINGLE_DECK,
  });
  const app = await makeApp(root);
  const post = (url: string, body: unknown, extra: Record<string, string | null> = {}) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json", ...extra }),
      body: JSON.stringify(body),
    });
  const files = async (dir: string) => {
    const out: Record<string, string> = {};
    for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath, entry.name);
      out[path.relative(dir, full)] = await fs.readFile(full, "utf8");
    }
    return out;
  };
  return { root, app, post, files };
}

const errorCode = async (response: Response) => (await response.json()).error.code;

describe("POST /api/decks/:id/duplicate", () => {
  it("copies a folder deck beside itself, lists it, and leaves the original alone", async () => {
    const { root, app, post, files } = await setup();
    const before = await files(path.join(root, "talk"));
    const response = await post(`/api/decks/${encodeDeckId("talk")}/duplicate`, {
      name: "talk-copy",
      title: "Folder deck (copy)",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(DuplicateDeckResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ deckId: encodeDeckId("talk-copy"), skipped: [] });

    const copy = await files(path.join(root, "talk-copy"));
    expect(Object.keys(copy).sort()).toEqual(
      Object.keys(before)
        .filter((name) => !name.startsWith("dist"))
        .sort(),
    );
    expect(copy["presentation.yml"]).toBe(
      before["presentation.yml"]!.replace("Folder deck", "Folder deck (copy)"),
    );
    expect(await files(path.join(root, "talk"))).toEqual(before);

    const workspace = await (await app.request("/api/workspace", { headers: headers() })).json();
    const ids = workspace.decks.map((deck: { id: string }) => deck.id);
    expect(ids).toEqual(expect.arrayContaining([encodeDeckId("talk"), encodeDeckId("talk-copy")]));
    const detail = await (await app.request(`/api/decks/${body.deckId}`, { headers: headers() })).json();
    expect(detail.title).toBe("Folder deck (copy)");
    expect(detail.slides).toHaveLength(2);
  });

  it("copies a single-file deck next to it", async () => {
    const { root, post } = await setup();
    const response = await post(`/api/decks/${encodeDeckId("solo.slide.md")}/duplicate`, {
      name: "solo-2",
      title: "Single 2",
    });
    expect(response.status).toBe(201);
    expect((await response.json()).deckId).toBe(encodeDeckId("solo-2.slide.md"));
    const copy = await discoverPresentation(path.join(root, "solo-2.slide.md"));
    expect(copy.title).toBe("Single 2");
    expect(copy.slides).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "solo.slide.md"), "utf8")).toBe(SINGLE_DECK);
  });

  it("lists skipped symlinks and never copies them", async () => {
    const { root, post } = await setup();
    const outside = await tempDir("studio-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "talk", "assets", "secret.txt"));
    const response = await post(`/api/decks/${encodeDeckId("talk")}/duplicate`, {
      name: "linked",
      title: "L",
    });
    expect(response.status).toBe(201);
    expect((await response.json()).skipped).toEqual(["assets/secret.txt"]);
    await expect(fs.lstat(path.join(root, "linked", "assets", "secret.txt"))).rejects.toThrow();
  });

  it("maps refusals and writes nothing", async () => {
    const { root, post } = await setup();
    await write(root, { "broken/presentation.yml": "title: [oops\n" });
    const before = (await fs.readdir(root)).sort();
    const taken = await post(`/api/decks/${encodeDeckId("talk")}/duplicate`, { name: "talk", title: "T" });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("DECK_EXISTS");
    const bad = await post(`/api/decks/${encodeDeckId("talk")}/duplicate`, { name: "Bad Name", title: "T" });
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe("VALIDATION_FAILED");
    const missing = await post(`/api/decks/${encodeDeckId("nope")}/duplicate`, { name: "x", title: "T" });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("DECK_NOT_FOUND");
    const broken = await post(`/api/decks/${encodeDeckId("broken")}/duplicate`, { name: "x", title: "T" });
    expect(broken.status).toBe(422);
    expect(await errorCode(broken)).toBe("DECK_LOAD_FAILED");
    expect((await fs.readdir(root)).sort()).toEqual(before);
  });

  it("is behind the local guard", async () => {
    const { root, post } = await setup();
    const url = `/api/decks/${encodeDeckId("talk")}/duplicate`;
    expect((await post(url, { name: "a", title: "A" }, { "x-flipbook-token": null })).status).toBe(403);
    expect((await post(url, { name: "b", title: "B" }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(url, { name: "c", title: "C" }, { host: "evil.test" })).status).toBe(403);
    expect((await fs.readdir(root)).sort()).toEqual(["solo.slide.md", "talk"]);
  });
});

describe("POST /api/kits/:kind/:name/copy", () => {
  it("copies a built-in theme into the library", async () => {
    const { post } = await setup();
    const response = await post("/api/kits/theme/marvel-jarvis/copy", { toName: "my-theme" });
    expect(response.status).toBe(201);
    const doc = await response.json();
    expect(doc.ref).toEqual({ kind: "theme", name: "my-theme", scope: "library" });
    expect(doc.builtIn).toBe(false);
    expect(await fs.readFile(path.join(library, "themes", "my-theme.css"), "utf8")).toBe(doc.source);
  });

  it("copies library templates and blueprints", async () => {
    const { app, post } = await setup();
    await write(library, {
      "templates/quote.yml": "column: 1\nrow: 2\nwidth: 3\nheight: 1\nalign: start\n",
      "blueprints/talk.yml": "pages:\n  - type: cover\ntypes:\n  cover:\n    template: cover\n",
    });
    const template = await post("/api/kits/template/quote/copy", { toName: "quote_wide" });
    expect(template.status).toBe(201);
    expect((await template.json()).parsed.width).toBe(3);
    const blueprint = await post("/api/kits/blueprint/talk/copy", { toName: "talk-2", scope: "library" });
    expect(blueprint.status).toBe(201);
    const read = await app.request("/api/kits/blueprint/talk-2?scope=library", { headers: headers() });
    expect(read.status).toBe(200);
  });

  it("copies groups through both routes", async () => {
    const { post } = await setup();
    const generic = await post("/api/kits/group/marvel_content_guide/copy", { toName: "brand" });
    expect(generic.status).toBe(201);
    expect((await generic.json()).ref).toEqual({ kind: "group", name: "brand", scope: "library" });
    expect(await fs.readFile(path.join(library, "templates", "brand.yml"), "utf8")).toMatch(/brand_/);
    const clash = await post("/api/kits/group/marvel_content_item/copy", { toName: "brand" });
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe("KIT_EXISTS");
  });

  it("maps refusals and writes nothing", async () => {
    const { post } = await setup();
    await write(library, { "themes/taken.css": "/* mine */\n" });
    const taken = await post("/api/kits/theme/marvel-jarvis/copy", { toName: "taken" });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("KIT_EXISTS");
    const missing = await post("/api/kits/blueprint/nowhere/copy", { toName: "x" });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("KIT_NOT_FOUND");
    const bad = await post("/api/kits/theme/marvel-jarvis/copy", { toName: "Bad Name" });
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe("VALIDATION_FAILED");
    const kind = await post("/api/kits/widget/x/copy", { toName: "y" });
    expect(kind.status).toBe(404);
    expect(await fs.readdir(path.join(library, "themes"))).toEqual(["taken.css"]);
  });
});
