import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { scriptFree } from "../src/server/decks.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/ws");

describe("GET /api/decks/:id", () => {
  it("loads the blueprint-talk example with script-free slide documents", async () => {
    const app = await makeApp(fixtures);
    const response = await app.request(`/api/decks/${encodeDeckId("blueprint-talk")}`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const deck = await response.json();
    expect(deck).toMatchObject({
      path: "blueprint-talk",
      kind: "folder",
      title: "Brief a Decision",
      group: null,
    });
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides[0]).toMatchObject({
      id: "slides/01_cover.slide.md",
      index: 0,
      template: "cover",
      type: "cover",
    });
    for (const slide of deck.slides) {
      expect(slide.html).not.toMatch(/<script/i);
      expect(slide.html).toContain('<template shadowrootmode="open">');
    }
    expect(Object.keys(deck.hashes)).toContain("presentation.yml");
    expect(deck.hashes["presentation.yml"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives single-file decks #index slide IDs", async () => {
    const root = await tempDir();
    await write(root, { "one.slide.md": "# A\n\n---\n\n# B\n" });
    const app = await makeApp(root);
    const deck = await (
      await app.request(`/api/decks/${encodeDeckId("one.slide.md")}`, { headers: headers() })
    ).json();
    expect(deck.slides.map((slide: { id: string }) => slide.id)).toEqual(["#0", "#1"]);
    expect(Object.keys(deck.hashes)).toEqual(["one.slide.md"]);
  });

  it("returns 404 DECK_NOT_FOUND for an unknown ID", async () => {
    const app = await makeApp(await tempDir());
    for (const id of [encodeDeckId("nope"), "%%%"]) {
      const response = await app.request(`/api/decks/${id}`, { headers: headers() });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("DECK_NOT_FOUND");
    }
  });

  it("returns 422 DECK_LOAD_FAILED with the path and core's message for a broken manifest", async () => {
    const root = await tempDir();
    await write(root, { "broken/presentation.yml": "- just\n- a list\n" });
    const app = await makeApp(root);
    const response = await app.request(`/api/decks/${encodeDeckId("broken")}`, { headers: headers() });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "DECK_LOAD_FAILED",
      path: "broken",
      message: expect.stringContaining("must contain a YAML object"),
    });
  });
});

describe("GET /api/decks/:id/files/*", () => {
  async function folderApp() {
    const root = await tempDir();
    await write(
      root,
      Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`deck/${name}`, body])),
    );
    await write(root, { "secret.txt": "top secret" });
    return { app: await makeApp(root), id: encodeDeckId("deck") };
  }

  it("serves deck assets with the sandbox CSP and no token", async () => {
    const { app, id } = await folderApp();
    const response = await app.request(`/api/decks/${id}/files/assets/logo.svg`, {
      headers: headers({ "x-flipbook-token": null }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toContain("<svg");
  });

  it.each([
    // A literal ../ is normalized away by URL parsing and never reaches the files route.
    ["../secret.txt", 404],
    ["..%2Fsecret.txt", 403],
    ["assets%2F..%2F..%2Fsecret.txt", 403],
    ["%2e%2e%2Fsecret.txt", 403],
    ["%2Fetc%2Fpasswd", 403],
    ["%252e%252e%252Fsecret.txt", 404],
    ["assets/missing.png", 404],
  ])("files/%s → %i", async (relative, status) => {
    const { app, id } = await folderApp();
    const response = await app.request(`/api/decks/${id}/files/${relative}`, { headers: headers() });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("top secret");
  });

  it("refuses a wrong Host and non-GET methods", async () => {
    const { app, id } = await folderApp();
    const rebound = await app.request(`/api/decks/${id}/files/assets/logo.svg`, {
      headers: headers({ host: "attacker.com" }),
    });
    expect(rebound.status).toBe(403);
    const post = await app.request(`/api/decks/${id}/files/assets/logo.svg`, {
      method: "POST",
      headers: headers(),
    });
    expect(post.status).toBe(403);
  });
});

describe("scriptFree", () => {
  it("moves the export payload into a declarative shadow root and drops scripts", () => {
    const html = `<body><div id="canvas" class="canvas"></div><script>document.getElementById("canvas").attachShadow({mode:"open"}).innerHTML=${JSON.stringify("<p>Hi</p>").replace(/</g, "\\u003c")};</script></body>`;
    expect(scriptFree(html)).toBe(
      '<body><div id="canvas" class="canvas"><template shadowrootmode="open"><p>Hi</p></template></div></body>',
    );
    expect(scriptFree("<p>x</p><script>alert(1)</script>")).toBe("<p>x</p>");
  });
});
