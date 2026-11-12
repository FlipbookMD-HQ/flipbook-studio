import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir, write } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
// `flipbook check` from FLIPBOOK_CLI or a sibling checkout; the parity check is skipped without one.
const sibling = path.resolve(here, "../../flipbook-md/bin/flipbook.js");
const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);

let home: string | undefined;
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

type App = Awaited<ReturnType<typeof makeApp>>;
const talk = encodeDeckId("talk");
const CONCLUSION = "slides/05_conclusion.slide.md";
const LONG = `# Ask for the yes\n\n${"Name the owner, the option, and the date. ".repeat(8).trim()}`;
const MAX_CHARS = `${CONCLUSION}: visible text is 350 characters; maximum is 250.`;

async function setup() {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  return { root, app: await makeApp(root) };
}

function send(app: App, method: string, url: string, body: unknown) {
  return app.request(url, {
    method,
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const detail = async (app: App, id = talk) =>
  (await app.request(`/api/decks/${id}`, { headers: headers() })).json();

describe("violations in the API", () => {
  it("a valid deck has a blueprint and no violations", async () => {
    const { app } = await setup();
    const deck = await detail(app);
    expect(deck.hasBlueprint).toBe(true);
    expect(deck.violations).toEqual([]);
    expect(deck.slides[4]).toMatchObject({ source: CONCLUSION, violations: [] });
  });

  it("a preview draft over max_chars returns MAX_CHARS for that slide; fixing it clears the list", async () => {
    const { app } = await setup();
    const slide = (await detail(app)).slides[4];
    const url = `/api/decks/${talk}/preview`;
    const broken = await (
      await send(app, "POST", url, { slideId: slide.id, draft: { ...slide.draft, markdown: LONG } })
    ).json();
    expect(broken.violations).toEqual([{ source: CONCLUSION, code: "MAX_CHARS", message: MAX_CHARS }]);
    const fixed = await (await send(app, "POST", url, { slideId: slide.id, draft: slide.draft })).json();
    expect(fixed.violations).toEqual([]);
  });

  it("a preview returns the whole deck's violations with the draft applied", async () => {
    const { root, app } = await setup();
    await fs.writeFile(path.join(root, "talk", CONCLUSION), `${LONG}\n`);
    const slide = (await detail(app)).slides[1];
    const draft = { ...slide.draft, markdown: "# Point\n\n```\ncode\n```" };
    const response = await (
      await send(app, "POST", `/api/decks/${talk}/preview`, { slideId: slide.id, draft })
    ).json();
    expect(response.violations.map((violation: { code: string }) => violation.code)).toEqual([
      "NOT_ALLOWED",
      "MAX_CHARS",
    ]);
  });

  it("a deck that breaks its blueprint on disk still opens, with each slide's violations", async () => {
    const { root, app } = await setup();
    await fs.writeFile(path.join(root, "talk", CONCLUSION), `${LONG}\n`);
    const response = await app.request(`/api/decks/${talk}`, { headers: headers() });
    expect(response.status).toBe(200);
    const deck = await response.json();
    expect(deck.violations).toEqual([{ source: CONCLUSION, code: "MAX_CHARS", message: MAX_CHARS }]);
    expect(deck.slides[4].violations).toEqual(deck.violations);
    expect(deck.slides[0].violations).toEqual([]);
    const workspace = await (await app.request("/api/workspace", { headers: headers() })).json();
    expect(workspace.decks.find((entry: { path: string }) => entry.path === "talk").error).toBeNull();

    if (cli) {
      const run = await promisify(execFile)(process.execPath, [cli, "check", path.join(root, "talk")]).catch(
        (error) => error,
      );
      expect(String(run.stderr).trim().split("\n")).toEqual(
        deck.violations.map((violation: { message: string }) => violation.message),
      );
    }
  });

  it("save and structure routes return the deck's violations", async () => {
    const { app } = await setup();
    const deck = await detail(app);
    const slide = deck.slides[4];
    const saved = await (
      await send(app, "PUT", `/api/decks/${talk}/slides/${encodeURIComponent(slide.id)}`, {
        baseHash: deck.hashes[slide.file],
        draft: { ...slide.draft, markdown: LONG },
      })
    ).json();
    expect(saved.violations.map((violation: { code: string }) => violation.code)).toEqual(["MAX_CHARS"]);
    expect(saved.slide.violations).toEqual(saved.violations);

    const moved = await (
      await send(app, "PUT", `/api/decks/${talk}/order`, {
        baseHash: saved.hashes["presentation.yml"] ?? deck.hashes["presentation.yml"],
        slideIds: [...deck.slides.map((item: { id: string }) => item.id)].reverse(),
      })
    ).json();
    expect(moved.violations[0]).toMatchObject({ code: "ORDER" });
  });

  it("an invalid draft template is still RENDER_FAILED with details.field", async () => {
    const { app } = await setup();
    const slide = (await detail(app)).slides[1];
    const response = await send(app, "POST", `/api/decks/${talk}/preview`, {
      slideId: slide.id,
      draft: { ...slide.draft, template: "nope" },
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "RENDER_FAILED",
      details: { field: "template" },
    });
  });

  it("a deck with no blueprint returns hasBlueprint false", async () => {
    const root = await tempDir();
    await write(root, { "plain.slide.md": "# A\n\n---\n\n# B\n" });
    const app = await makeApp(root);
    const deck = await detail(app, encodeDeckId("plain.slide.md"));
    expect(deck).toMatchObject({ hasBlueprint: false, violations: [] });
    expect(deck.slides[1]).toMatchObject({ source: "slide 2", violations: [] });
  });
});
