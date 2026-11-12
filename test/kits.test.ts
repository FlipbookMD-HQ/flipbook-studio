import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { libraryRoot } from "@flipbook-md/core";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
const THEME = ":root {\n  --accent: #ff0055;\n}\n";

let home: string | undefined;
let library: string;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  library = await tempDir("studio-kits-home-");
  process.env.FLIPBOOK_HOME = library;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

async function setup() {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  await fs.writeFile(path.join(root, "solo.slide.md"), "---\ntitle: Solo\nstyle: dusk\n---\n# One\n");
  return { root, app: await makeApp(root) };
}
type App = Awaited<ReturnType<typeof setup>>["app"];

const send = (app: App, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("kit routes", () => {
  it("creates (201), reads and updates a library theme, and lists the decks using it", async () => {
    const { app } = await setup();
    const created = await send(app, "POST", "/api/kits/theme", {
      name: "dusk",
      scope: "library",
      source: THEME,
    });
    expect(created.status).toBe(201);
    const kit = await created.json();
    expect(kit).toMatchObject({
      ref: { kind: "theme", name: "dusk", scope: "library" },
      source: THEME,
      builtIn: false,
    });
    expect(kit.usedBy).toEqual([encodeDeckId("solo.slide.md")]);
    expect(await fs.readFile(path.join(library, "themes/dusk.css"), "utf8")).toBe(THEME);

    const again = await send(app, "POST", "/api/kits/theme", {
      name: "dusk",
      scope: "library",
      source: THEME,
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("KIT_EXISTS");

    const changed = THEME.replace("#ff0055", "#00ff88");
    const updated = await send(app, "PUT", "/api/kits/theme/dusk", {
      scope: "library",
      baseHash: kit.hash,
      source: changed,
    });
    expect(updated.status).toBe(200);
    const stale = await send(app, "PUT", "/api/kits/theme/dusk", {
      scope: "library",
      baseHash: kit.hash,
      source: THEME,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("FILE_CONFLICT");

    const read = await (await send(app, "GET", "/api/kits/theme/dusk?scope=library")).json();
    expect(read.source).toBe(changed);
    const workspace = await (await send(app, "GET", "/api/workspace")).json();
    expect(workspace.library.themes).toContainEqual({ kind: "theme", name: "dusk", scope: "library" });
  });

  it("reads built-ins but refuses to write them (403 BUILT_IN_READONLY)", async () => {
    const { app } = await setup();
    const builtin = await send(app, "GET", "/api/kits/theme/marvel-jarvis?scope=builtin");
    expect(builtin.status).toBe(200);
    const kit = await builtin.json();
    expect(kit.builtIn).toBe(true);
    const before = await fs.readFile(path.join(libraryRoot(), "themes/marvel-jarvis.css"), "utf8");
    const write = await send(app, "PUT", "/api/kits/theme/marvel-jarvis", {
      scope: "builtin",
      baseHash: kit.hash,
      source: THEME,
    });
    expect(write.status).toBe(403);
    expect((await write.json()).error.code).toBe("BUILT_IN_READONLY");
    expect(await fs.readFile(path.join(libraryRoot(), "themes/marvel-jarvis.css"), "utf8")).toBe(before);
  });

  it("answers 404 KIT_NOT_FOUND, 422 for traversal and reserved names, and 422 KIT_INVALID", async () => {
    const { app } = await setup();
    const missing = await send(app, "GET", "/api/kits/theme/nope?scope=library");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("KIT_NOT_FOUND");

    for (const name of ["../x", "..", "a/b"]) {
      const response = await send(app, "POST", "/api/kits/theme", { name, scope: "library", source: THEME });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
    expect(await fs.readdir(library)).toEqual([]);

    const reserved = await send(app, "POST", "/api/kits/template", {
      name: "cover",
      scope: "library",
      source: "column: 1\nrow: 1\nwidth: 1\nheight: 1\nalign: start\n",
    });
    expect(reserved.status).toBe(422);
    expect((await reserved.json()).error.code).toBe("RESERVED_NAME");

    const invalid = await send(app, "POST", "/api/kits/template", {
      name: "aside",
      scope: "library",
      source: "column: 3\nrow: 1\nwidth: 2\nheight: 1\nalign: start\n",
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error).toMatchObject({
      code: "KIT_INVALID",
      message: expect.stringMatching(/3x3 grid/),
    });

    const patch = await send(app, "PUT", "/api/kits/theme/dusk", {
      scope: "library",
      baseHash: "0".repeat(64),
      patch: {},
    });
    expect(patch.status).toBe(422);
    expect((await send(app, "GET", "/api/kits/palette/x?scope=library")).status).toBe(404);
  });

  it("writes a deck theme to presentation.css and lists it on the deck", async () => {
    const { root, app } = await setup();
    const talk = encodeDeckId("talk");
    const created = await send(app, "POST", "/api/kits/theme", {
      name: "presentation",
      scope: "deck",
      deckId: talk,
      source: THEME,
    });
    expect(created.status).toBe(201);
    expect((await created.json()).ref).toMatchObject({ scope: "deck", deckId: talk, name: "presentation" });
    expect(await fs.readFile(path.join(root, "talk/presentation.css"), "utf8")).toBe(THEME);
    const workspace = await (await send(app, "GET", "/api/workspace")).json();
    expect(workspace.decks.find((deck: { path: string }) => deck.path === "talk").deckKits).toContain(
      "theme",
    );

    const single = await send(app, "POST", "/api/kits/theme", {
      name: "presentation",
      scope: "deck",
      deckId: encodeDeckId("solo.slide.md"),
      source: THEME,
    });
    expect(single.status).toBe(422);
  });

  it("previews a theme on the sample deck and on a deck's own slides", async () => {
    const { app } = await setup();
    const sample = await send(app, "POST", "/api/kits/theme/preview", { source: ":root{--accent:#abcdef}" });
    expect(sample.status).toBe(200);
    const { html, errors } = await sample.json();
    expect(errors).toEqual([]);
    expect([...html.matchAll(/data-sample="([^"]+)"/g)].map((match: RegExpMatchArray) => match[1])).toEqual([
      "cover",
      "content",
      "quote",
      "media",
      "callout",
    ]);
    expect(html).toContain("--accent:#abcdef");
    expect(html).not.toMatch(/<script/i);

    const onDeck = await (
      await send(app, "POST", "/api/kits/theme/preview", {
        source: ":root{--accent:#abcdef}",
        deckId: encodeDeckId("talk"),
      })
    ).json();
    expect(onDeck.html).toContain("Name the decision");
    expect(onDeck.html).toContain("--accent:#abcdef");
  });

  it("previews a built-in theme quickly (p95 under 150 ms)", async () => {
    const { app } = await setup();
    const source = await fs.readFile(path.join(libraryRoot(), "themes/marvel-jarvis.css"), "utf8");
    const times: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();
      const response = await send(app, "POST", "/api/kits/theme/preview", { source, scope: "builtin" });
      expect(response.status).toBe(200);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95) - 1]).toBeLessThan(150);
  });
});
