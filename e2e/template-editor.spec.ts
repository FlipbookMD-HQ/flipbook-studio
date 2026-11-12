import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";

const STUDIO = "http://127.0.0.1:4396/";
const WORKSPACE = path.resolve(".e2e-kits");
const LIBRARY = path.resolve(".e2e-library");
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
const CLI = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);

test.describe.configure({ mode: "serial" });

/** Drags across the grid from one cell to another (column, row, 1-based). */
async function dragCells(page: Page, from: [number, number], to: [number, number]) {
  const cell = (column: number, row: number) => page.locator(`[data-cell="${column},${row}"]`);
  const a = (await cell(...from).boundingBox())!;
  const b = (await cell(...to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
}

test("a 2×1 region at row 2, align start, saved to both scopes matches flipbook template add", async ({
  page,
}) => {
  await page.goto(`${STUDIO}kits/templates`);
  await page.getByRole("link", { name: "New template" }).click();
  await page.getByLabel("Name").fill("quote");
  await dragCells(page, [1, 2], [2, 2]);
  await expect(page.getByLabel("Column", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Row", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Height", { exact: true })).toHaveValue("1");
  await page.getByLabel("start").check();
  await expect
    .poll(async () => (await page.getByTestId("template-preview").getAttribute("srcdoc")) ?? "")
    .toMatch(/\[data-template="quote"\][^}]*grid-column:1 \/ 3;grid-row:2/);

  await page.getByLabel("A deck's templates.yml").check();
  await page.getByLabel("Deck", { exact: true }).selectOption({ label: "Themed deck" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${STUDIO}kits/templates/library/quote`);

  const studio = await fs.readFile(path.join(LIBRARY, "templates/quote.yml"), "utf8");
  expect(parse(await fs.readFile(path.join(WORKSPACE, "themed-deck/templates.yml"), "utf8"))).toEqual({
    quote: parse(studio),
  });
  if (CLI) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-cli-"));
    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "template",
        "add",
        "quote",
        "--column",
        "1",
        "--row",
        "2",
        "--width",
        "2",
        "--height",
        "1",
        "--align",
        "start",
      ],
      { cwd: home, env: { ...process.env, FLIPBOOK_HOME: home }, encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    const cli = await fs.readFile(path.join(home, "templates/quote.yml"), "utf8");
    expect(parse(studio)).toEqual(parse(cli));
    expect(studio).toBe(cli);
  }
});

test("a slide using <!-- template: quote --> renders with the region in the deck editor", async ({
  page,
}) => {
  await fs.writeFile(
    path.join(WORKSPACE, "themed-deck/slides/02_slide.slide.md"),
    "<!-- template: quote -->\n# Second\n\n- One\n- Two\n",
  );
  await page.goto(
    `${STUDIO}decks/${id("themed-deck")}/slides/${encodeURIComponent("slides/02_slide.slide.md")}`,
  );
  await expect
    .poll(async () => (await page.getByTestId("preview").getAttribute("srcdoc")) ?? "")
    .toContain('<main class="content" data-template="quote"');
  const srcdoc = (await page.getByTestId("preview").getAttribute("srcdoc")) ?? "";
  expect(srcdoc).toContain('<main class="content" data-template="quote"');
  expect(srcdoc).toMatch(/\[data-template="quote"\][^}]*grid-column:1 \/ 3;grid-row:2/);
});

test("reserved names and out-of-bounds regions block saving, and keys move the region", async ({ page }) => {
  await page.goto(`${STUDIO}kits/templates/new`);
  const save = page.getByRole("button", { name: "Save" });
  await page.getByLabel("Name").fill("cover");
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("save-reason")).toHaveText(
    '"cover" is a built-in template. Pick another name.',
  );

  await page.getByLabel("Name").fill("aside");
  await expect(save).toBeEnabled();
  await page.getByLabel("Column", { exact: true }).fill("3");
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("save-reason")).toHaveText("The region spills past the grid's right edge.");

  // Keyboard: Shift+Left shrinks, arrows move, all inside the grid.
  await page.getByLabel("Column", { exact: true }).fill("1");
  await page.getByTestId("grid-editor").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByLabel("Column", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Row", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("1");
  await expect(page.getByLabel("Height", { exact: true })).toHaveValue("2");
  await expect(save).toBeEnabled();
});

test("saving to both scopes reports each outcome and keeps the successful write", async ({ page }) => {
  await page.goto(`${STUDIO}kits/templates/new`);
  await page.getByLabel("Name").fill("quote");
  await page.getByLabel("A deck's templates.yml").check();
  await page.getByLabel("Deck", { exact: true }).selectOption({ label: "Themed deck" });
  await page.getByLabel("center").check();
  await page.getByRole("button", { name: "Save" }).click();
  const outcomes = page.getByTestId("save-outcomes");
  await expect(outcomes).toContainText('Library: A template named "quote" already exists.');
  await expect(outcomes).toContainText("Deck: Saved.");
  expect(
    parse(await fs.readFile(path.join(WORKSPACE, "themed-deck/templates.yml"), "utf8")).quote.align,
  ).toBe("center");
});
