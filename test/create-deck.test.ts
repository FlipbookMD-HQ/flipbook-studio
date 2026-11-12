import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

let home: string | undefined;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

async function post(app: Awaited<ReturnType<typeof makeApp>>, body: unknown) {
  return app.request("/api/decks", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/decks", () => {
  it("creates a blank folder deck: 201 with DeckDetail, listed in the workspace", async () => {
    const root = await tempDir();
    const app = await makeApp(root);
    const response = await post(app, { name: "my-talk", title: "My talk", kind: "folder", group: null });
    expect(response.status).toBe(201);
    const deck = await response.json();
    expect(deck).toMatchObject({
      id: encodeDeckId("my-talk"),
      path: "my-talk",
      kind: "folder",
      title: "My talk",
      group: null,
    });
    expect(deck.slides).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "my-talk/presentation.yml"), "utf8")).toContain(
      "title: My talk",
    );

    const workspace = await (await app.request("/api/workspace", { headers: headers() })).json();
    expect(workspace.decks.map((d: { path: string }) => d.path)).toEqual(["my-talk"]);
  });

  it("creates a single-file deck from a kit with one placeholder per required step", async () => {
    const root = await tempDir();
    const app = await makeApp(root);
    const response = await post(app, {
      name: "places",
      title: "Places",
      kind: "single",
      group: "marvel_content_place",
    });
    expect(response.status).toBe(201);
    const deck = await response.json();
    expect(deck).toMatchObject({ path: "places.slide.md", kind: "single", group: "marvel_content_place" });
    expect(deck.slides.map((slide: { type: string }) => slide.type)).toEqual(["cover", "toc"]); // content has repeat.min 0;
  });

  it("returns 409 DECK_EXISTS for a taken name, including a case-only clash, and keeps the original", async () => {
    const root = await tempDir();
    const app = await makeApp(root);
    expect((await post(app, { name: "talk", title: "Talk", kind: "folder", group: null })).status).toBe(201);
    const before = await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8");
    const again = await post(app, { name: "talk", title: "Other", kind: "folder", group: null });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatchObject({ code: "DECK_EXISTS", path: "talk" });
    await fs.mkdir(path.join(root, "Shout"));
    expect((await post(app, { name: "shout", title: "Shout", kind: "folder", group: null })).status).toBe(
      409,
    );
    expect(await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8")).toBe(before);
  });

  it("returns 404 KIT_NOT_FOUND for an unknown group", async () => {
    const app = await makeApp(await tempDir());
    const response = await post(app, { name: "x", title: "X", kind: "folder", group: "no_such_kit" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("KIT_NOT_FOUND");
  });

  it.each([
    [{ name: "Bad Slug", title: "T", kind: "folder", group: null }, "name"],
    [{ name: "x".repeat(61), title: "T", kind: "folder", group: null }, "name"],
    [{ name: "ok", title: "   ", kind: "folder", group: null }, "title"],
    [{ name: "ok", title: "t".repeat(121), kind: "folder", group: null }, "title"],
    [{ name: "ok", title: "T", kind: "deck", group: null }, "kind"],
    [{ name: "ok", title: "T", kind: "folder" }, "group"],
  ])("returns 422 VALIDATION_FAILED for %j", async (body, field) => {
    const root = await tempDir();
    const response = await post(await makeApp(root), body);
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details.fields.map((f: { path: string }) => f.path)).toContain(field);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("returns 422 for a body that is not JSON", async () => {
    const response = await post(await makeApp(await tempDir()), "{not json");
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("needs the launch token like every other /api route", async () => {
    const app = await makeApp(await tempDir());
    const response = await app.request("/api/decks", {
      method: "POST",
      headers: headers({ "x-flipbook-token": null, "content-type": "application/json" }),
      body: JSON.stringify({ name: "x", title: "X", kind: "folder", group: null }),
    });
    expect(response.status).toBe(403);
  });
});
