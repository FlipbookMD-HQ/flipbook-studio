import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

let home: string | undefined;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

type App = Awaited<ReturnType<typeof makeApp>>;

const MANIFEST =
  "# talk\ntitle: Talk\nslides:\n  - slides/01_intro.slide.md # first\n  - slides/02_point.slide.md\n";
const FILES = {
  "talk/presentation.yml": MANIFEST,
  "talk/slides/01_intro.slide.md": "# Intro\n",
  "talk/slides/02_point.slide.md": "# Point\n",
  "one.slide.md": "# A\n\n---\n\n# B\n",
};
const talk = encodeDeckId("talk");
const one = encodeDeckId("one.slide.md");
const draft = { markdown: "# Added", template: null, type: null, notes: "", title: null, directives: {} };

async function setup() {
  const root = await tempDir();
  await write(root, FILES);
  return { root, app: await makeApp(root) };
}

function call(app: App, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function hashes(app: App, id: string): Promise<Record<string, string>> {
  return (await (await call(app, "GET", `/api/decks/${id}`)).json()).hashes;
}

describe("POST /api/decks/:id/slides", () => {
  it("adds a folder slide after another and returns it with every slide and hash", async () => {
    const { root, app } = await setup();
    const base = (await hashes(app, talk))["presentation.yml"];
    const response = await call(app, "POST", `/api/decks/${talk}/slides`, {
      baseHash: base,
      afterSlideId: "slides/01_intro.slide.md",
      draft,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.slide).toMatchObject({ id: "slides/03_slide.slide.md", index: 1, title: "Added" });
    expect(body.slides.map((slide: { id: string }) => slide.id)).toEqual([
      "slides/01_intro.slide.md",
      "slides/03_slide.slide.md",
      "slides/02_point.slide.md",
    ]);
    expect(body.hashes["presentation.yml"]).not.toBe(base);
    expect(body.hashes["slides/03_slide.slide.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(body.violations).toEqual([]);
    expect(await fs.readFile(path.join(root, "talk/slides/03_slide.slide.md"), "utf8")).toBe("# Added\n");
    expect(await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8")).toContain("# first");
  });

  it("adds a single-file chunk", async () => {
    const { root, app } = await setup();
    const response = await call(app, "POST", `/api/decks/${one}/slides`, {
      baseHash: (await hashes(app, one))["one.slide.md"],
      afterSlideId: "#1",
      draft,
    });
    expect(response.status).toBe(201);
    expect((await response.json()).slide).toMatchObject({ id: "#2", title: "Added" });
    expect(await fs.readFile(path.join(root, "one.slide.md"), "utf8")).toBe(
      "# A\n\n---\n\n# B\n\n---\n\n# Added\n",
    );
  });

  it("returns 409 FILE_CONFLICT on a stale manifest hash and writes nothing", async () => {
    const { root, app } = await setup();
    const base = (await hashes(app, talk))["presentation.yml"];
    await fs.appendFile(path.join(root, "talk/presentation.yml"), "theme: midnight\n");
    const response = await call(app, "POST", `/api/decks/${talk}/slides`, {
      baseHash: base,
      afterSlideId: null,
      draft,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "FILE_CONFLICT", path: "presentation.yml" });
    expect(await fs.readdir(path.join(root, "talk/slides"))).toHaveLength(2);
  });
});

describe("DELETE /api/decks/:id/slides/:slideId", () => {
  const url = (id: string, slideId: string, baseHash: string) =>
    `/api/decks/${id}/slides/${encodeURIComponent(slideId)}?baseHash=${baseHash}`;

  it("removes the manifest entry and the file", async () => {
    const { root, app } = await setup();
    const response = await call(
      app,
      "DELETE",
      url(talk, "slides/01_intro.slide.md", (await hashes(app, talk))["presentation.yml"]!),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slides.map((slide: { id: string }) => slide.id)).toEqual(["slides/02_point.slide.md"]);
    expect(body.hashes["slides/01_intro.slide.md"]).toBeUndefined();
    expect(await fs.readdir(path.join(root, "talk/slides"))).toEqual(["02_point.slide.md"]);
  });

  it("returns 422 LAST_SLIDE for the only slide", async () => {
    const { root, app } = await setup();
    const first = await call(app, "DELETE", url(one, "#0", (await hashes(app, one))["one.slide.md"]!));
    expect(first.status).toBe(200);
    expect(await fs.readFile(path.join(root, "one.slide.md"), "utf8")).toBe("# B\n");
    const last = await call(app, "DELETE", url(one, "#0", (await first.json()).hashes["one.slide.md"]));
    expect(last.status).toBe(422);
    expect((await last.json()).error.code).toBe("LAST_SLIDE");
    expect(await fs.readFile(path.join(root, "one.slide.md"), "utf8")).toBe("# B\n");
  });

  it("returns 409 on a stale hash, 404 for an unknown slide and 422 without a hash", async () => {
    const { root, app } = await setup();
    const base = (await hashes(app, talk))["presentation.yml"]!;
    expect((await call(app, "DELETE", url(talk, "slides/99.slide.md", base))).status).toBe(404);
    expect(
      (
        await call(
          app,
          "DELETE",
          `/api/decks/${talk}/slides/${encodeURIComponent("slides/01_intro.slide.md")}`,
        )
      ).status,
    ).toBe(422);
    await fs.appendFile(path.join(root, "talk/presentation.yml"), "# edited\n");
    expect((await call(app, "DELETE", url(talk, "slides/01_intro.slide.md", base))).status).toBe(409);
    expect(await fs.readdir(path.join(root, "talk/slides"))).toHaveLength(2);
  });
});

describe("PUT /api/decks/:id/order", () => {
  it("changes only the manifest order in a folder deck", async () => {
    const { root, app } = await setup();
    const response = await call(app, "PUT", `/api/decks/${talk}/order`, {
      baseHash: (await hashes(app, talk))["presentation.yml"],
      slideIds: ["slides/02_point.slide.md", "slides/01_intro.slide.md"],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slides.map((slide: { title: string }) => slide.title)).toEqual(["Point", "Intro"]);
    expect(await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8")).toBe(
      "# talk\ntitle: Talk\nslides:\n  - slides/02_point.slide.md # first\n  - slides/01_intro.slide.md\n",
    );
    expect(await fs.readFile(path.join(root, "talk/slides/01_intro.slide.md"), "utf8")).toBe("# Intro\n");
  });

  it("moves single-file chunks and renumbers their IDs", async () => {
    const { root, app } = await setup();
    const response = await call(app, "PUT", `/api/decks/${one}/order`, {
      baseHash: (await hashes(app, one))["one.slide.md"],
      slideIds: ["#1", "#0"],
    });
    const body = await response.json();
    expect(body.slides.map((slide: { id: string; title: string }) => `${slide.id} ${slide.title}`)).toEqual([
      "#0 B",
      "#1 A",
    ]);
    expect(await fs.readFile(path.join(root, "one.slide.md"), "utf8")).toBe("# B\n\n---\n\n# A\n");
  });

  it("returns 422 for a bad permutation and 409 on a stale hash", async () => {
    const { root, app } = await setup();
    const base = (await hashes(app, talk))["presentation.yml"];
    const bad = await call(app, "PUT", `/api/decks/${talk}/order`, {
      baseHash: base,
      slideIds: ["slides/02_point.slide.md"],
    });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { field: "slideIds" },
    });
    await fs.appendFile(path.join(root, "talk/presentation.yml"), "# edited\n");
    const stale = await call(app, "PUT", `/api/decks/${talk}/order`, {
      baseHash: base,
      slideIds: ["slides/02_point.slide.md", "slides/01_intro.slide.md"],
    });
    expect(stale.status).toBe(409);
    expect(await fs.readFile(path.join(root, "talk/presentation.yml"), "utf8")).toBe(`${MANIFEST}# edited\n`);
  });
});
