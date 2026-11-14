import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/server/app.js";
import { encodeDeckId } from "../src/server/paths.js";
import { ASSET_MAX_BYTES } from "../src/shared/api.js";
import { FOLDER_DECK, SINGLE_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-16: deck image routes (tech-spec D18-D20).
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0]),
]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([16, 0, 9, 0, 0, 0, 0]), Buffer.from(";")]);

async function setup(files: Record<string, string> = {}) {
  const root = await tempDir();
  await write(root, {
    ...Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`talk/${name}`, body])),
    "one.slide.md": SINGLE_DECK,
    ...files,
  });
  const app = await makeApp(root);
  const folder = encodeDeckId("talk");
  const single = encodeDeckId("one.slide.md");
  const upload = (deckId: string, name: string, bytes: Buffer, extra: Record<string, string | null> = {}) => {
    const form = new FormData();
    form.append("file", new File([Buffer.from(bytes)], name, { type: "application/octet-stream" }));
    return app.request(`/api/decks/${deckId}/assets`, {
      method: "POST",
      headers: headers(extra),
      body: form,
    });
  };
  const list = async (deckId: string) =>
    (await (await app.request(`/api/decks/${deckId}/assets`, { headers: headers() })).json()).assets;
  const remove = (deckId: string, assetPath: string, force = false) =>
    app.request(
      // assetPath is sent as written, so tests can send encoded separators.
      `/api/decks/${deckId}/${assetPath}${force ? "?force=1" : ""}`,
      { method: "DELETE", headers: headers() },
    );
  return { root, app, folder, single, upload, list, remove };
}

describe("deck image routes", () => {
  it("uploads under a new name, lists with size, dimensions and users, and never overwrites", async () => {
    const { root, folder, upload, list } = await setup();
    const first = await upload(folder, "Cover Photo.PNG", PNG);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      asset: {
        path: "assets/cover-photo.png",
        bytes: PNG.length,
        mime: "image/png",
        width: 40,
        height: 30,
        usedBy: [],
      },
    });
    expect((await (await upload(folder, "cover photo.png", PNG)).json()).asset.path).toBe(
      "assets/cover-photo-2.png",
    );

    const assets = await list(folder);
    expect(assets.map((asset: { path: string }) => asset.path)).toEqual([
      "assets/cover-photo-2.png",
      "assets/cover-photo.png",
      "assets/logo.svg",
    ]);
    expect(assets[2]).toMatchObject({
      width: 4,
      height: 4,
      usedBy: [{ deckId: folder, deckPath: "talk", slideId: "slides/01.slide.md", label: "1. First" }],
    });
    expect(await fs.readFile(path.join(root, "talk/assets/cover-photo.png"))).toEqual(PNG);
  });

  it("lists nothing for a deck without an assets folder", async () => {
    const { single, list } = await setup();
    expect(await list(single)).toEqual([]);
  });

  it("refuses other types, disguised files and oversize uploads, and writes nothing", async () => {
    const { root, folder, upload } = await setup();
    const cases: [string, Buffer, number, string][] = [
      ["notes.bmp", Buffer.from("BM"), 415, "ASSET_TYPE"],
      ["page.png", Buffer.from("<html><script>alert(1)</script></html>"), 422, "ASSET_CONTENT_MISMATCH"],
      ["evil.svg", Buffer.from("<html><svg/></html>"), 422, "ASSET_CONTENT_MISMATCH"],
      ["huge.png", Buffer.concat([PNG, Buffer.alloc(ASSET_MAX_BYTES)]), 413, "ASSET_TOO_LARGE"],
    ];
    for (const [name, bytes, status, code] of cases) {
      const response = await upload(folder, name, bytes);
      expect(response.status, name).toBe(status);
      expect((await response.json()).error.code, name).toBe(code);
    }
    expect(await fs.readdir(path.join(root, "talk/assets"))).toEqual(["logo.svg"]);
  });

  it("cuts a body far past the limit while it streams", async () => {
    const { root, folder, upload } = await setup();
    const response = await upload(
      folder,
      "huge.png",
      Buffer.concat([PNG, Buffer.alloc(ASSET_MAX_BYTES * 2)]),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("ASSET_TOO_LARGE");
    expect(await fs.readdir(path.join(root, "talk/assets"))).toEqual(["logo.svg"]);
  });

  it("still holds other routes to 2 MB", async () => {
    const { app, folder } = await setup();
    const response = await app.request(`/api/decks/${folder}/preview`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("asks for a multipart file field", async () => {
    const { app, folder } = await setup();
    const form = new FormData();
    form.append("image", new File([PNG], "a.png"));
    const response = await app.request(`/api/decks/${folder}/assets`, {
      method: "POST",
      headers: headers(),
      body: form,
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses uploads without the token or from another site", async () => {
    const { root, folder, upload } = await setup();
    expect((await upload(folder, "a.png", PNG, { "x-flipbook-token": null })).status).toBe(403);
    expect((await upload(folder, "a.png", PNG, { origin: "https://evil.test" })).status).toBe(403);
    expect(await fs.readdir(path.join(root, "talk/assets"))).toEqual(["logo.svg"]);
  });

  it("deletes an unused image, and asks first for a used one", async () => {
    const { root, folder, upload, remove } = await setup();
    await upload(folder, "spare.gif", GIF);
    expect((await remove(folder, "assets/spare.gif")).status).toBe(204);
    await expect(fs.stat(path.join(root, "talk/assets/spare.gif"))).rejects.toThrow();

    const used = await remove(folder, "assets/logo.svg");
    expect(used.status).toBe(409);
    expect((await used.json()).error).toMatchObject({
      code: "ASSET_IN_USE",
      details: { usedBy: [{ slideId: "slides/01.slide.md", label: "1. First" }] },
    });
    expect((await remove(folder, "assets/logo.svg", true)).status).toBe(204);
    await expect(fs.stat(path.join(root, "talk/assets/logo.svg"))).rejects.toThrow();
    expect((await (await remove(folder, "assets/logo.svg")).json()).error.code).toBe("ASSET_NOT_FOUND");
  });

  it("never deletes outside the assets folder", async () => {
    const { root, folder, remove } = await setup();
    for (const bad of [
      "assets/..%2Fpresentation.yml",
      "assets/sub/x.png",
      "assets/.hidden.png",
      "assets/x.txt",
    ]) {
      const response = await remove(folder, bad);
      expect([403, 404], bad).toContain(response.status);
    }
    expect((await fs.stat(path.join(root, "talk/presentation.yml"))).isFile()).toBe(true);
  });

  it("counts every single-file deck that shares the workspace assets folder", async () => {
    const { single, upload, list, remove } = await setup({
      "two.slide.md": "---\ntitle: Two\n---\n# Uses it\n\n![shared](assets/shared.gif)\n",
    });
    expect((await (await upload(single, "shared.gif", GIF)).json()).asset.path).toBe("assets/shared.gif");
    const [asset] = await list(single);
    expect(asset.usedBy).toEqual([
      {
        deckId: encodeDeckId("two.slide.md"),
        deckPath: "two.slide.md",
        slideId: "#0",
        label: "two.slide.md · 1. Uses it",
      },
    ]);
    expect((await remove(single, "assets/shared.gif")).status).toBe(409);
  });

  it("serves uploaded images with their type, nosniff and the sandbox CSP", async () => {
    const { app, folder, upload } = await setup();
    await upload(folder, "a.png", PNG);
    const response = await app.request(`/api/decks/${folder}/files/assets/a.png`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const svg = await app.request(`/api/decks/${folder}/files/assets/logo.svg`, { headers: headers() });
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
  });

  it("returns 404 for an unknown deck", async () => {
    const { list, upload } = await setup();
    expect((await upload(encodeDeckId("nope"), "a.png", PNG)).status).toBe(404);
    await expect(list(encodeDeckId("nope"))).resolves.toBeUndefined();
  });
});
