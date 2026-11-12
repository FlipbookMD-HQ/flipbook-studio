import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

let home: string | undefined;
let library: string;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  library = await tempDir("studio-group-home-");
  process.env.FLIPBOOK_HOME = library;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

const SOURCE = `name: brand
description: Our talks
style: marvel-jarvis
canvas: midnight
themes:
  - marvel-jarvis
  - marvel-herbie
chrome:
  counter:
    corner: bottom-right
    line: solid
    line_align: middle
    line_length: 40%
templates:
  brand_cover:
    column: 1
    row: 1
    width: 3
    height: 3
    align: center
    role: cover
blueprint:
  pages:
    - type: cover
    - type: point
      repeat:
        min: 1
        max: 5
  types:
    cover:
      template: brand_cover
    point: {}
`;

async function setup() {
  const root = await tempDir();
  await fs.mkdir(path.join(root, "uses-brand/slides"), { recursive: true });
  await fs.writeFile(
    path.join(root, "uses-brand/presentation.yml"),
    "title: Uses brand\ngroup: brand\nslides:\n  - slides/01.slide.md\n",
  );
  await fs.writeFile(path.join(root, "uses-brand/slides/01.slide.md"), "<!-- type: cover -->\n# Hi\n");
  await fs.writeFile(path.join(root, "other.slide.md"), "---\ntitle: Other\n---\n# Other\n");
  return { root, app: await makeApp(root, [], { library }) };
}
type App = Awaited<ReturnType<typeof setup>>["app"];
const send = (app: App, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("group kits", () => {
  it("creates a group in templates/, patches its chrome, and lists the decks using it", async () => {
    const { app } = await setup();
    const created = await send(app, "POST", "/api/kits/group", {
      name: "brand",
      scope: "library",
      source: SOURCE,
    });
    expect(created.status).toBe(201);
    const kit = await created.json();
    expect(kit.usedBy).toEqual([encodeDeckId("uses-brand")]);
    const patched = await send(app, "PUT", "/api/kits/group/brand", {
      scope: "library",
      baseHash: kit.hash,
      patch: { chrome: { counter: { corner: "top-left", ornament: "◆" } } },
    });
    expect(patched.status).toBe(200);
    expect(await fs.readFile(path.join(library, "templates/brand.yml"), "utf8")).toBe(
      SOURCE.replace("    corner: bottom-right\n", "    corner: top-left\n").replace(
        "    line_length: 40%\n",
        "    line_length: 40%\n    ornament: ◆\n",
      ),
    );
    const workspace = await (await send(app, "GET", "/api/workspace")).json();
    expect(workspace.library.groups).toContainEqual(
      expect.objectContaining({ name: "brand", scope: "library" }),
    );
  });

  it("previews one sample slide per page step, and reports an invalid group", async () => {
    const { app } = await setup();
    const preview = await (await send(app, "POST", "/api/kits/group/preview", { source: SOURCE })).json();
    expect(preview.errors).toEqual([]);
    expect([...preview.html.matchAll(/data-sample="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "cover",
      "point",
    ]);
    expect(preview.html).toContain('data-template="brand_cover"');
    const bad = await (
      await send(app, "POST", "/api/kits/group/preview", {
        source: SOURCE.replace("style: marvel-jarvis", "style: nowhere"),
      })
    ).json();
    expect(bad.html).toBe("");
    expect(bad.errors[0]).toMatch(/style must be one of its themes/);
  });

  it("copies a built-in into the library, leaving the built-in untouched; a clash is 409", async () => {
    const { app } = await setup();
    const builtIn = await (
      await send(app, "GET", "/api/kits/group/marvel_content_guide?scope=builtin")
    ).json();
    const copied = await send(app, "POST", "/api/kits/group/marvel_content_guide/copy", {
      toName: "my_guide",
    });
    expect(copied.status).toBe(201);
    const kit = await copied.json();
    expect(kit.ref).toMatchObject({ name: "my_guide", scope: "library" });
    expect(
      Object.keys(parse(kit.source).templates).every((name: string) => name.startsWith("my_guide_")),
    ).toBe(true);
    const again = await (await send(app, "GET", "/api/kits/group/marvel_content_guide?scope=builtin")).json();
    expect(again.hash).toBe(builtIn.hash);
    const clash = await send(app, "POST", "/api/kits/group/marvel_content_item/copy", { toName: "my_guide" });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("KIT_EXISTS");
    const missing = await send(app, "POST", "/api/kits/group/nowhere/copy", { toName: "x" });
    expect(missing.status).toBe(404);
  });

  it("renames a library group, reporting the decks still on the old name; a clash is 409", async () => {
    const { app } = await setup();
    const kit = await (
      await send(app, "POST", "/api/kits/group", { name: "brand", scope: "library", source: SOURCE })
    ).json();
    await send(app, "POST", "/api/kits/group/marvel_content_item/copy", { toName: "taken" });
    const clash = await send(app, "POST", "/api/kits/group/brand/rename", {
      toName: "taken",
      baseHash: kit.hash,
    });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error.code).toBe("KIT_EXISTS");

    const renamed = await send(app, "POST", "/api/kits/group/brand/rename", {
      toName: "talks",
      baseHash: kit.hash,
    });
    expect(renamed.status).toBe(200);
    const body = await renamed.json();
    expect(body.decksUsingOldName).toEqual([encodeDeckId("uses-brand")]);
    expect(body.kit.ref.name).toBe("talks");
    expect(parse(body.kit.source).blueprint.types.cover.template).toBe("talks_cover");
    await expect(fs.access(path.join(library, "templates/brand.yml"))).rejects.toThrow();
  });

  it("refuses to change a built-in: PUT and rename are 403", async () => {
    const { app } = await setup();
    const builtIn = await (
      await send(app, "GET", "/api/kits/group/marvel_content_guide?scope=builtin")
    ).json();
    const put = await send(app, "PUT", "/api/kits/group/marvel_content_guide", {
      scope: "builtin",
      baseHash: builtIn.hash,
      patch: { description: "Mine" },
    });
    expect(put.status).toBe(403);
    expect((await put.json()).error.code).toBe("BUILT_IN_READONLY");
    const rename = await send(app, "POST", "/api/kits/group/marvel_content_guide/rename", {
      toName: "mine",
      baseHash: builtIn.hash,
    });
    expect(rename.status).toBe(403);
  });
});
