import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { parse } from "yaml";

const STUDIO = "http://127.0.0.1:4398/";
const WORKSPACE = path.resolve(".e2e-media");
const LIBRARY = path.resolve(".e2e-media-library");
const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
const CLI = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
const CORE = path.dirname(createRequire(import.meta.url).resolve("@flipbook-md/core/package.json"));
// The CLI reads kits from FLIPBOOK_HOME. No PATH, so `flipbook show` can't open a browser.
const cliEnv = { FLIPBOOK_HOME: LIBRARY, PATH: "" };

test.describe.configure({ mode: "serial" });

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true });
const preview = (page: Page) => page.frameLocator('[data-testid="kit-preview"]');

/** The counter's attributes and the centre of its box as a fraction of its slide's box. */
async function counterSpot(counter: Locator, slide: Locator) {
  const [a, b] = [(await counter.boundingBox())!, (await slide.boundingBox())!];
  return {
    corner: await counter.getAttribute("data-corner"),
    line: await counter.getAttribute("data-line"),
    align: await counter.getAttribute("data-line-align"),
    text: (await counter.locator(".page-counter-mark").textContent())?.trim(),
    x: (a.x + a.width / 2 - b.x) / b.width,
    y: (a.y + a.height / 2 - b.y) / b.height,
  };
}

test("assemble a kit, save it, create a deck from it, and the CLI checks and shows that deck", async ({
  page,
}) => {
  await page.goto(`${STUDIO}kits/media`);
  await page.getByRole("link", { name: "New media kit" }).click();
  await page.getByLabel("Kit name").fill("launch_kit");

  await tab(page, "Themes");
  await page.getByRole("checkbox", { name: /^marvel-herbie/ }).check();
  // The style must stay one of the selected themes.
  await page.getByRole("checkbox", { name: /^marvel-jarvis/ }).uncheck();
  await expect(page.getByText("The style must be one of the selected themes.").first()).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await page.getByRole("checkbox", { name: /^marvel-jarvis/ }).check();

  await tab(page, "Templates");
  for (const name of ["quote", "aside"]) {
    await page.getByLabel("Import from library").selectOption(name);
    await page.getByRole("button", { name: `Import as launch_kit_${name}` }).click();
    await expect(page.getByTestId(`kit-template-${name}`)).toBeVisible();
  }

  await tab(page, "Blueprint");
  await page.getByLabel("Start from library blueprint").selectOption("talk");
  await expect(page.getByLabel("closing template")).toHaveValue("launch_kit_quote");
  await expect(page.getByLabel("point template")).toHaveValue("launch_kit_aside");
  // Only built-ins and the kit's own templates are offered.
  const offered = await page.getByLabel("point template").locator("option").allTextContents();
  expect(offered.slice(1).sort()).toEqual([
    "cover",
    "flow",
    "launch_kit_aside",
    "launch_kit_cover",
    "launch_kit_quote",
    "summary",
  ]);

  await tab(page, "Chrome");
  await page.getByLabel("Counter corner").selectOption("bottom-right");
  await page.getByLabel("Ornament (glyph or image path)").fill("◆");
  await expect(preview(page).locator('[data-sample="point"]').first()).toBeVisible();
  await expect(preview(page).locator('[data-sample="closing"]')).toHaveCount(1);

  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page).toHaveURL(/\/kits\/media\/library\/launch_kit$/);
  const kit = parse(await fs.readFile(path.join(LIBRARY, "templates/launch_kit.yml"), "utf8"));
  expect(kit.themes).toEqual(["marvel-herbie", "marvel-jarvis"]);
  expect(Object.keys(kit.templates).sort()).toEqual([
    "launch_kit_aside",
    "launch_kit_cover",
    "launch_kit_quote",
  ]);
  expect(kit.chrome.counter).toMatchObject({ corner: "bottom-right", ornament: "◆" });
  const previewCounter = await counterSpot(
    preview(page).locator('[data-sample="point"]').first().locator(".page-counter"),
    preview(page).locator('[data-sample="point"]').first().locator(".frame"),
  );

  // A deck from the kit in the new-deck dialog.
  await page.goto(STUDIO);
  await page.getByRole("button", { name: "New deck" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New deck" });
  await dialog.getByLabel("Title").fill("Launch");
  await dialog.getByRole("radio", { name: /launch_kit/ }).check();
  await dialog.getByRole("button", { name: "Create deck" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Launch");
  await expect(page.getByTestId("slide-thumb")).toHaveCount(4);

  test.skip(!CLI, "flipbook-md CLI not found next to this repo; set FLIPBOOK_CLI");
  const deck = path.join(WORKSPACE, "launch");
  const check = spawnSync(process.execPath, [CLI!, "check", deck], { encoding: "utf8", env: cliEnv });
  expect(check.status, check.stderr).toBe(0);
  expect(check.stdout).toMatch(/4 slide\(s\) match launch_kit/);

  const show = spawn(process.execPath, [CLI!, "show", deck], { env: cliEnv });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      show.stdout.on("data", (chunk) => {
        out += String(chunk);
        const match = /Open: (http:\/\/\S+)/.exec(out);
        if (match) resolve(match[1]!);
      });
      show.on("exit", () => reject(new Error(`flipbook show exited: ${out}`)));
    });
    // The counter in the player matches the kit preview for the same chrome.
    await page.goto(`${url}/?slide=2`);
    const playerCounter = await counterSpot(page.locator("#slide .page-counter"), page.locator("#slide"));
    expect({ ...playerCounter, x: undefined, y: undefined }).toEqual({
      ...previewCounter,
      x: undefined,
      y: undefined,
    });
    expect(playerCounter.text).toBe("01");
    expect(playerCounter.x).toBeGreaterThan(0.5);
    expect(playerCounter.y).toBeGreaterThan(0.75);
    expect(previewCounter.x).toBeGreaterThan(0.5);
    expect(previewCounter.y).toBeGreaterThan(0.75);
    await page.screenshot({ path: test.info().outputPath("player-counter.png") });
  } finally {
    show.kill();
  }
});

test("editing a built-in kit leads to Save as copy, and the built-in stays untouched", async ({ page }) => {
  const builtInFile = path.join(CORE, "library/templates/marvel_content_guide.yml");
  const before = await fs.readFile(builtInFile, "utf8");
  await page.goto(`${STUDIO}kits/media/builtin/marvel_content_guide`);
  await expect(page.getByTestId("builtin-note")).toBeVisible();
  await expect(save(page)).toHaveCount(0);
  await page.getByLabel("Description").fill("My reading guide.");
  await page.getByRole("button", { name: "Save as copy" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("New kit name").fill("my_guide");
  await dialog.getByRole("button", { name: "Save copy" }).click();
  await expect(page).toHaveURL(/\/kits\/media\/library\/my_guide$/);
  const copy = await fs.readFile(path.join(LIBRARY, "templates/my_guide.yml"), "utf8");
  expect(copy).toBe(
    before
      .replaceAll("marvel_content_guide", "my_guide")
      .replace(/^description: .*$/m, "description: My reading guide."),
  );
  expect(await fs.readFile(builtInFile, "utf8")).toBe(before);
});

test("renaming a kit warns about the decks using it and reports them", async ({ page }) => {
  await page.goto(`${STUDIO}kits/media/library/launch_kit`);
  await page.getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("rename-warning")).toContainText(
    "1 deck(s) use launch_kit — they won't load until updated",
  );
  await expect(dialog.getByTestId("rename-warning")).toContainText("Launch");
  await dialog.getByLabel("New kit name").fill("event_kit");
  await dialog.getByRole("button", { name: "Rename kit" }).click();
  await expect(page).toHaveURL(/\/kits\/media\/library\/event_kit$/);
  await expect(page.getByTestId("rename-result")).toContainText("1 deck(s) use launch_kit");
  await expect(page.getByTestId("rename-result").getByRole("link", { name: "Launch" })).toBeVisible();
  const renamed = parse(await fs.readFile(path.join(LIBRARY, "templates/event_kit.yml"), "utf8"));
  expect(renamed.blueprint.types.closing.template).toBe("event_kit_quote");
  await expect(fs.access(path.join(LIBRARY, "templates/launch_kit.yml"))).rejects.toThrow();
});
