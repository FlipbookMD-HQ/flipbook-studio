import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
const talk = encodeDeckId("talk");

let home: string | undefined;
let library: string;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  library = await tempDir("studio-bp-home-");
  process.env.FLIPBOOK_HOME = library;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

async function setup() {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  const source = await fs.readFile(path.join(root, "talk/blueprint.yml"), "utf8");
  return { root, source, app: await makeApp(root, [], { library }) };
}
type App = Awaited<ReturnType<typeof setup>>["app"];
const send = (app: App, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("blueprint kits", () => {
  it("creates and patches a library blueprint in blueprints/, listed in the workspace", async () => {
    const { app, source } = await setup();
    const created = await send(app, "POST", "/api/kits/blueprint", {
      name: "talk",
      scope: "library",
      source,
    });
    expect(created.status).toBe(201);
    const kit = await created.json();
    const patched = await send(app, "PUT", "/api/kits/blueprint/talk", {
      scope: "library",
      baseHash: kit.hash,
      patch: { types: { point: { max_items: 4 } } },
    });
    expect(patched.status).toBe(200);
    expect(await fs.readFile(path.join(library, "blueprints/talk.yml"), "utf8")).toBe(
      source.replace(
        "    allow: [heading, paragraph, list]\n",
        "    allow: [heading, paragraph, list]\n    max_items: 4\n",
      ),
    );
    const workspace = await (await send(app, "GET", "/api/workspace")).json();
    expect(workspace.library.blueprints).toEqual([{ kind: "blueprint", name: "talk", scope: "library" }]);
  });

  it("creates a deck blueprint and patches it", async () => {
    const { root, app, source } = await setup();
    await fs.rm(path.join(root, "talk/blueprint.yml"));
    const created = await send(app, "POST", "/api/kits/blueprint", {
      name: "blueprint",
      scope: "deck",
      deckId: talk,
      source,
    });
    expect(created.status).toBe(201);
    const kit = await created.json();
    await send(app, "PUT", "/api/kits/blueprint/blueprint", {
      scope: "deck",
      deckId: talk,
      baseHash: kit.hash,
      patch: { types: { conclusion: { max_chars: 300 } } },
    });
    expect(await fs.readFile(path.join(root, "talk/blueprint.yml"), "utf8")).toBe(
      source.replace("max_chars: 250", "max_chars: 300"),
    );
  });

  it("previews a draft against a deck: affectedSlides for a tightened rule, errors for an unknown template", async () => {
    const { app, source } = await setup();
    const ok = await (
      await send(app, "POST", "/api/kits/blueprint/preview", { source, deckId: talk })
    ).json();
    expect(ok).toEqual({ html: "", errors: [], affectedSlides: [] });

    const tight = await (
      await send(app, "POST", "/api/kits/blueprint/preview", {
        source: source.replace("max_chars: 250", "max_chars: 20"),
        deckId: talk,
      })
    ).json();
    expect(tight.affectedSlides).toEqual([
      expect.objectContaining({ source: "slides/05_conclusion.slide.md", code: "MAX_CHARS" }),
    ]);

    const unknown = await send(app, "POST", "/api/kits/blueprint/preview", {
      source: source.replace("template: summary", "template: nowhere"),
      deckId: talk,
    });
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).errors).toEqual([expect.stringMatching(/unknown template "nowhere"/)]);

    const noDeck = await (
      await send(app, "POST", "/api/kits/blueprint/preview", { source: "pages: []\ntypes: {}\n" })
    ).json();
    expect(noDeck.errors).toEqual([expect.stringMatching(/non-empty "pages"/)]);
  });

  it("refuses to save an invalid draft with 422 KIT_INVALID", async () => {
    const { app, source } = await setup();
    const zero = await send(app, "POST", "/api/kits/blueprint", {
      name: "empty",
      scope: "library",
      source: "pages: []\ntypes: {}\n",
    });
    expect(zero.status).toBe(422);
    expect((await zero.json()).error.code).toBe("KIT_INVALID");
    const undefinedType = await send(app, "POST", "/api/kits/blueprint", {
      name: "bad",
      scope: "library",
      source: source.replace("  - type: conclusion", "  - type: epilogue"),
    });
    expect((await undefinedType.json()).error).toMatchObject({
      code: "KIT_INVALID",
      message: expect.stringMatching(/unknown type/),
    });
    await expect(fs.readdir(path.join(library, "blueprints"))).rejects.toThrow();
  });
});
