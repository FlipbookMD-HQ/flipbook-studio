import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
const QUOTE = "column: 1\nrow: 2\nwidth: 2\nheight: 1\nalign: start\n";

let home: string | undefined;
let library: string;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  library = await tempDir("studio-tpl-home-");
  process.env.FLIPBOOK_HOME = library;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

async function setup() {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  return { root, app: await makeApp(root) };
}
type App = Awaited<ReturnType<typeof setup>>["app"];
const send = (app: App, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const talk = encodeDeckId("talk");

describe("template kits", () => {
  it("creates a library template and patches only its align", async () => {
    const { app } = await setup();
    const created = await send(app, "POST", "/api/kits/template", {
      name: "quote",
      scope: "library",
      source: QUOTE,
    });
    expect(created.status).toBe(201);
    const kit = await created.json();
    expect(kit.parsed).toMatchObject({
      name: "quote",
      column: 1,
      row: 2,
      width: 2,
      height: 1,
      align: "start",
    });

    const patched = await send(app, "PUT", "/api/kits/template/quote", {
      scope: "library",
      baseHash: kit.hash,
      patch: { align: "center" },
    });
    expect(patched.status).toBe(200);
    expect(await fs.readFile(path.join(library, "templates/quote.yml"), "utf8")).toBe(
      QUOTE.replace("align: start", "align: center"),
    );
  });

  it("creates a deck template by patching templates.yml, which is created when missing", async () => {
    const { root, app } = await setup();
    const created = await send(app, "PUT", `/api/kits/template/quote`, {
      scope: "deck",
      deckId: talk,
      baseHash: null,
      patch: { column: 1, row: 2, width: 2, height: 1, align: "start" },
    });
    expect(created.status).toBe(200);
    const kit = await created.json();
    expect(kit.ref).toMatchObject({ kind: "template", name: "quote", scope: "deck", deckId: talk });
    expect(await fs.readFile(path.join(root, "talk/templates.yml"), "utf8")).toBe(
      "quote:\n  column: 1\n  row: 2\n  width: 2\n  height: 1\n  align: start\n",
    );
    const second = await send(app, "PUT", `/api/kits/template/aside`, {
      scope: "deck",
      deckId: talk,
      baseHash: kit.hash,
      patch: { column: 3, row: 1, width: 1, height: 1, align: "end" },
    });
    expect((await second.json()).parsed).toHaveProperty("aside");
    const read = await (await send(app, "GET", `/api/kits/template/quote?scope=deck&deckId=${talk}`)).json();
    expect(Object.keys(read.parsed)).toEqual(["quote", "aside"]);
  });

  it("refuses reserved names (422 RESERVED_NAME) and out-of-bounds regions (422 KIT_INVALID)", async () => {
    const { root, app } = await setup();
    for (const name of ["flow", "cover", "summary"]) {
      const library = await send(app, "POST", "/api/kits/template", {
        name,
        scope: "library",
        source: QUOTE,
      });
      expect((await library.json()).error.code).toBe("RESERVED_NAME");
      const deck = await send(app, "PUT", `/api/kits/template/${name}`, {
        scope: "deck",
        deckId: talk,
        baseHash: null,
        patch: { column: 1 },
      });
      expect(deck.status).toBe(422);
      expect((await deck.json()).error.code).toBe("RESERVED_NAME");
    }
    const spill = await send(app, "POST", "/api/kits/template", {
      name: "wide",
      scope: "library",
      source: QUOTE.replace("column: 1", "column: 2").replace("width: 2", "width: 3"),
    });
    expect(spill.status).toBe(422);
    expect((await spill.json()).error).toMatchObject({
      code: "KIT_INVALID",
      message: expect.stringMatching(/3x3 grid/),
    });
    await expect(fs.access(path.join(root, "talk/templates.yml"))).rejects.toThrow();
  });

  it("reports a mixed result for both scopes: the successful write stays", async () => {
    const { root, app } = await setup();
    // The library already has "quote", so only the deck write succeeds.
    await send(app, "POST", "/api/kits/template", { name: "quote", scope: "library", source: QUOTE });
    const [library, deck] = await Promise.all([
      send(app, "POST", "/api/kits/template", { name: "quote", scope: "library", source: QUOTE }),
      send(app, "PUT", "/api/kits/template/quote", {
        scope: "deck",
        deckId: talk,
        baseHash: null,
        patch: { column: 1, row: 2, width: 2, height: 1, align: "start" },
      }),
    ]);
    expect(library.status).toBe(409);
    expect(deck.status).toBe(200);
    expect(await fs.readFile(path.join(root, "talk/templates.yml"), "utf8")).toContain("quote:");
  });

  it("previews sample content placed in the region, and reports an invalid region as a preview error", async () => {
    const { app } = await setup();
    const preview = await (
      await send(app, "POST", "/api/kits/template/preview", { source: QUOTE, name: "quote", deckId: talk })
    ).json();
    expect(preview.errors).toEqual([]);
    expect(preview.html).toContain('data-template="quote"');
    expect(preview.html).toMatch(/\[data-template="quote"\][^}]*grid-column:1 \/ 3;grid-row:2/);
    expect(preview.html).toContain("Placed here");

    const bad = await send(app, "POST", "/api/kits/template/preview", {
      source: QUOTE.replace("column: 1", "column: 3"),
    });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ html: "", errors: [expect.stringMatching(/3x3 grid/)] });
  });

  it("patches every YAML kind and refuses sending both source and patch", async () => {
    const { root, app } = await setup();
    const kit = await (
      await send(app, "GET", `/api/kits/blueprint/blueprint?scope=deck&deckId=${talk}`)
    ).json();
    const before = await fs.readFile(path.join(root, "talk/blueprint.yml"), "utf8");
    const patched = await send(app, "PUT", "/api/kits/blueprint/blueprint", {
      scope: "deck",
      deckId: talk,
      baseHash: kit.hash,
      patch: { types: { conclusion: { max_chars: 300 } } },
    });
    expect(patched.status).toBe(200);
    expect(await fs.readFile(path.join(root, "talk/blueprint.yml"), "utf8")).toBe(
      before.replace("max_chars: 250", "max_chars: 300"),
    );
    const both = await send(app, "PUT", "/api/kits/blueprint/blueprint", {
      scope: "deck",
      deckId: talk,
      baseHash: kit.hash,
      source: before,
      patch: {},
    });
    expect(both.status).toBe(422);
  });
});
