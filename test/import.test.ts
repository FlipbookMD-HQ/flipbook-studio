import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPresentation } from "@flipbook-md/core";
import { encodeDeckId } from "../src/server/paths.js";
import { TMP_DIR } from "../src/server/workspace.js";
import { ImportDeckResponseSchema } from "../src/shared/api.js";
import { PNG, buildDocx, docx } from "./support/docx.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

// US-18 · 2.2.1: POST /api/decks/import (tech-spec D17, D23, D25).

const GUIDE = buildDocx({
  body: [
    docx.heading(1, "Indexes"),
    docx.para("Why they matter."),
    docx.heading(2, "Kinds"),
    docx.bullet("B-tree"),
    docx.image("rIdImg", "a chart"),
    docx.heading(2, "Costs"),
    docx.para("Writes get slower."),
    docx.image("rIdEmf", "vector"),
  ].join(""),
  images: [
    { rel: "rIdImg", file: "chart.png", data: PNG },
    { rel: "rIdEmf", file: "v.emf", data: Buffer.from("EMF") },
  ],
});

async function setup() {
  const root = await tempDir();
  await write(root, {
    "taken/presentation.yml": "title: Taken\nslides:\n  - a.slide.md\n",
    "taken/a.slide.md": "# A\n",
  });
  const app = await makeApp(root);
  const upload = async (name: string, bytes: Buffer) => {
    const form = new FormData();
    form.append("file", new File([Buffer.from(bytes)], name));
    const response = await app.request("/api/sources", { method: "POST", headers: headers(), body: form });
    expect(response.status).toBe(201);
    return (await response.json()).source;
  };
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const importDeck = (body: object) =>
    post("/api/decks/import", { name: "guide", title: "Guide", group: null, ...body });
  const tmpLeft = async () =>
    (await fs.readdir(path.join(root, TMP_DIR)).catch(() => [] as string[])).filter(
      (name) => name !== "sources",
    );
  return { root, upload, post, importDeck, tmpLeft };
}

describe("POST /api/decks/import", () => {
  it("imports a .docx with its images and opens without violations", async () => {
    const { root, upload, importDeck, tmpLeft } = await setup();
    const source = await upload("guide.docx", GUIDE);
    const response = await importDeck({ sourceId: source.sourceId });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(ImportDeckResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      deckId: encodeDeckId("guide"),
      dropped: [{ kind: "image", reason: "type", count: 1, detail: "EMF" }],
      violations: [],
    });
    const deck = await discoverPresentation(path.join(root, "guide"));
    expect(deck.slides.map((slide) => slide.title)).toEqual(["Indexes", "Kinds", "Costs"]);
    const slide = (name: string) => fs.readFile(path.join(root, "guide", "slides", name), "utf8");
    expect(await slide("02-kinds.slide.md")).toContain("![a chart](assets/image1.png)");
    expect(await slide("03-costs.slide.md")).not.toContain("emf");
    expect(deck.slides[1]!.html).toContain("image1.png");
    expect(await fs.readdir(path.join(root, "guide", "assets"))).toEqual(["image1.png"]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("imports a .md with a kit and reports the kit's violations", async () => {
    const { root, upload, importDeck } = await setup();
    const source = await upload("notes.md", Buffer.from("# Notes\n\n## One\n\n- a\n"));
    const response = await importDeck({ sourceId: source.sourceId, group: "marvel_content_guide" });
    expect(response.status).toBe(201);
    const { violations } = await response.json();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((violation: { code: string }) => violation.code)).toContain("MISSING_TYPE");
    expect(await fs.readFile(path.join(root, "guide", "presentation.yml"), "utf8")).toContain(
      "group: marvel_content_guide",
    );
  });

  it("refuses a taken name before doing any work, and keeps the source for another try", async () => {
    const { upload, importDeck, tmpLeft } = await setup();
    const source = await upload("notes.md", Buffer.from("# Notes\n"));
    const response = await importDeck({ sourceId: source.sourceId, name: "taken" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("DECK_EXISTS");
    expect(await tmpLeft()).toEqual([]);
    expect((await importDeck({ sourceId: source.sourceId, name: "fresh" })).status).toBe(201);
  });

  it("keeps the temp deck for Save as when the name is taken while importing", async () => {
    const { root, upload, post, tmpLeft } = await setup();
    const source = await upload("notes.md", Buffer.from("# Notes\n\n## One\n\nx\n"));
    // A name that appears between the pre-check and the rename: a folder made by another process.
    const slowName = "racer";
    const original = fs.rename;
    const spy = async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to).endsWith(`${path.sep}${slowName}`)) {
        await fs.mkdir(to as string, { recursive: true });
        await fs.writeFile(path.join(to as string, "presentation.yml"), "title: Other\n");
      }
      return original(from, to);
    };
    (fs as { rename: typeof fs.rename }).rename = spy as typeof fs.rename;
    let response: Response;
    try {
      response = await post("/api/decks/import", {
        sourceId: source.sourceId,
        name: slowName,
        title: "R",
        group: null,
      });
    } finally {
      (fs as { rename: typeof fs.rename }).rename = original;
    }
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe("DECK_EXISTS");
    expect(await tmpLeft()).toEqual([error.details.runId]);
    const saved = await post(`/api/ai/generate-deck/${error.details.runId}/save-as`, { name: "racer-2" });
    expect(saved.status).toBe(201);
    expect((await discoverPresentation(path.join(root, "racer-2"))).slides).toHaveLength(2);
  });

  it("answers 404 for a missing kit, an unknown source, and a source already used", async () => {
    const { upload, importDeck } = await setup();
    const source = await upload("notes.md", Buffer.from("# Notes\n"));
    const missingKit = await importDeck({ sourceId: source.sourceId, group: "no_such_kit" });
    expect(missingKit.status).toBe(404);
    expect((await missingKit.json()).error.code).toBe("KIT_NOT_FOUND");
    expect((await importDeck({ sourceId: source.sourceId })).status).toBe(201);
    const reused = await importDeck({ sourceId: source.sourceId, name: "again" });
    expect(reused.status).toBe(404);
    expect((await reused.json()).error.code).toBe("SOURCE_EXPIRED");
    const unknown = await importDeck({ sourceId: "00000000-0000-4000-8000-000000000000", name: "x" });
    expect((await unknown.json()).error.code).toBe("SOURCE_EXPIRED");
  });

  it("validates the request", async () => {
    const { importDeck } = await setup();
    const response = await importDeck({ sourceId: "../../etc/passwd", name: "Bad Name" });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
