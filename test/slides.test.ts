import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPresentation } from "@flipbook-md/core";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "../fixtures/edit");

let home: string | undefined;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

type App = Awaited<ReturnType<typeof makeApp>>;

async function send(app: App, method: string, url: string, body: unknown) {
  return app.request(url, {
    method,
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function workspaceWith(files: Record<string, string>) {
  const root = await tempDir();
  await write(root, files);
  return { root, app: await makeApp(root) };
}

const TALK = {
  "talk/presentation.yml":
    "title: Talk\nslides:\n  - slides/01_intro.slide.md\n  - slides/02_point.slide.md\n",
  "talk/slides/01_intro.slide.md": "# Intro\n\nHello.\n",
  "talk/slides/02_point.slide.md": "<!-- template: cover -->\n# Point\n\nText.\n",
};
const talk = encodeDeckId("talk");

async function detail(app: App, id = talk) {
  return (await app.request(`/api/decks/${id}`, { headers: headers() })).json();
}

describe("GET /api/decks/:id with drafts", () => {
  it("returns each slide's draft, hash key and the deck's templates", async () => {
    const { app } = await workspaceWith(TALK);
    const deck = await detail(app);
    expect(deck.slides[1]).toMatchObject({
      id: "slides/02_point.slide.md",
      file: "slides/02_point.slide.md",
      draft: {
        markdown: "# Point\n\nText.",
        template: "cover",
        type: "point",
        notes: "",
        title: null,
        directives: {},
      },
    });
    expect(deck.hashes["slides/02_point.slide.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(deck.templates).toEqual(expect.arrayContaining(["flow", "cover", "summary"]));
    expect(deck.slides[0].html).not.toMatch(/<script/i);
  });
});

describe("POST /api/decks/:id/preview", () => {
  it("renders a draft, or the saved slide when the draft is null", async () => {
    const { app } = await workspaceWith(TALK);
    const disk = await send(app, "POST", `/api/decks/${talk}/preview`, {
      slideId: "slides/01_intro.slide.md",
      draft: null,
    });
    expect(disk.status).toBe(200);
    const saved = await disk.json();
    expect(saved.violations).toEqual([]);
    expect(saved.html).toContain(">Intro</h1>");

    const draft = {
      markdown: "# Draft title\n\nNew text.",
      template: "summary",
      type: null,
      notes: "",
      title: null,
      directives: {},
    };
    const drafted = await (
      await send(app, "POST", `/api/decks/${talk}/preview`, { slideId: "slides/01_intro.slide.md", draft })
    ).json();
    expect(drafted.html).toContain(">Draft title</h1>");
    expect(drafted.html).toContain('data-template="summary"');
    expect(drafted.html).not.toMatch(/<script/i);
  });

  it("returns 422 RENDER_FAILED with details.field for an unknown template", async () => {
    const { app } = await workspaceWith(TALK);
    const draft = { markdown: "# x", template: "nope", type: null, notes: "", title: null, directives: {} };
    const response = await send(app, "POST", `/api/decks/${talk}/preview`, {
      slideId: "slides/01_intro.slide.md",
      draft,
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "RENDER_FAILED",
      details: { field: "template" },
    });
  });

  it("returns 404 SLIDE_NOT_FOUND for an unknown slide", async () => {
    const { app } = await workspaceWith(TALK);
    const response = await send(app, "POST", `/api/decks/${talk}/preview`, {
      slideId: "slides/99.slide.md",
      draft: null,
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("SLIDE_NOT_FOUND");
  });

  it("answers in under 150 ms at p95 on database-indexes-project", async () => {
    const root = await tempDir();
    await fs.cp(path.join(examples, "database-indexes-project"), path.join(root, "db"), { recursive: true });
    const app = await makeApp(root);
    const id = encodeDeckId("db");
    const deck = await detail(app, id);
    const slide = deck.slides[2];
    const times: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const draft = { ...slide.draft, markdown: `${slide.draft.markdown}\n\nEdit ${run}` };
      const started = performance.now();
      const response = await send(app, "POST", `/api/decks/${id}/preview`, { slideId: slide.id, draft });
      expect(response.status).toBe(200);
      await response.json();
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(150);
  });
});

describe("PUT /api/decks/:id/slides/:slideId", () => {
  const url = (slideId: string) => `/api/decks/${talk}/slides/${encodeURIComponent(slideId)}`;

  it("saves a draft, changing only the edited line, and returns the SlideDoc and hashes", async () => {
    const { root, app } = await workspaceWith(TALK);
    const deck = await detail(app);
    const slide = deck.slides[1];
    const response = await send(app, "PUT", url(slide.id), {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, markdown: "# Point\n\nBetter text." },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.slide).toMatchObject({ id: slide.id, draft: { markdown: "# Point\n\nBetter text." } });
    expect(body.hashes[slide.file]).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hashes[slide.file]).not.toBe(deck.hashes[slide.file]);
    expect(body.violations).toEqual([]);
    expect(await fs.readFile(path.join(root, "talk", slide.file), "utf8")).toBe(
      "<!-- template: cover -->\n# Point\n\nBetter text.\n",
    );
  });

  it("saves a template the CLI loader renders the same way", async () => {
    const { root, app } = await workspaceWith(TALK);
    const deck = await detail(app);
    const slide = deck.slides[0];
    await send(app, "PUT", url(slide.id), {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, template: "summary" },
    });
    expect(await fs.readFile(path.join(root, "talk", slide.file), "utf8")).toBe(
      "<!-- template: summary -->\n# Intro\n\nHello.\n",
    );
    const loaded = await discoverPresentation(path.join(root, "talk"));
    expect(loaded.slides[0]!.template).toBe("summary");
  });

  it("saves a single-file slide by #index", async () => {
    const { root, app } = await workspaceWith({ "one.slide.md": "# A\n\n---\n\n# B\n" });
    const id = encodeDeckId("one.slide.md");
    const deck = await detail(app, id);
    const response = await send(app, "PUT", `/api/decks/${id}/slides/${encodeURIComponent("#1")}`, {
      baseHash: deck.hashes["one.slide.md"],
      draft: { ...deck.slides[1].draft, markdown: "# B2" },
    });
    expect(response.status).toBe(200);
    expect(await fs.readFile(path.join(root, "one.slide.md"), "utf8")).toBe("# A\n\n---\n\n# B2\n");
  });

  it("returns 409 FILE_CONFLICT with the current hash after an outside edit", async () => {
    const { root, app } = await workspaceWith(TALK);
    const deck = await detail(app);
    const slide = deck.slides[0];
    await fs.writeFile(path.join(root, "talk", slide.file), "# Edited in another app\n");
    const response = await send(app, "PUT", url(slide.id), {
      baseHash: deck.hashes[slide.file],
      draft: slide.draft,
    });
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("FILE_CONFLICT");
    expect(error.details.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(path.join(root, "talk", slide.file), "utf8")).toBe("# Edited in another app\n");
  });

  it("returns 500 WRITE_FAILED when the slide folder is read-only", async () => {
    const { root, app } = await workspaceWith(TALK);
    const deck = await detail(app);
    const slide = deck.slides[0];
    const folder = path.join(root, "talk/slides");
    await fs.chmod(folder, 0o555);
    try {
      const response = await send(app, "PUT", url(slide.id), {
        baseHash: deck.hashes[slide.file],
        draft: { ...slide.draft, markdown: "# Changed" },
      });
      expect(response.status).toBe(500);
      expect((await response.json()).error).toMatchObject({ code: "WRITE_FAILED", path: slide.id });
    } finally {
      await fs.chmod(folder, 0o755);
    }
    expect(await fs.readFile(path.join(folder, "01_intro.slide.md"), "utf8")).toBe("# Intro\n\nHello.\n");
  });

  it("returns 422 for an invalid draft and 404 for an unknown slide", async () => {
    const { app } = await workspaceWith(TALK);
    const deck = await detail(app);
    const slide = deck.slides[0];
    const bad = await send(app, "PUT", url(slide.id), {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, template: "nope" },
    });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { field: "template" },
    });
    const shape = await send(app, "PUT", url(slide.id), { baseHash: "abc", draft: slide.draft });
    expect(shape.status).toBe(422);
    const missing = await send(app, "PUT", url("slides/99.slide.md"), {
      baseHash: deck.hashes[slide.file],
      draft: slide.draft,
    });
    expect(missing.status).toBe(404);
  });
});
