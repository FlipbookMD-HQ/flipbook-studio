import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";

const STUDIO = "http://127.0.0.1:4397/";
const WORKSPACE = path.resolve(".e2e-blueprints");
const LIBRARY = path.resolve(".e2e-bp-library");
const TALK = Buffer.from("blueprint-talk", "utf8").toString("base64url");
const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
const CLI = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);

test.describe.configure({ mode: "serial" });

const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true });
const card = (page: Page, testId: string) => page.getByTestId(testId);

test("building blueprint-talk's blueprint in the form saves a library file that passes flipbook check", async ({
  page,
}) => {
  await page.goto(`${STUDIO}kits/blueprints`);
  await page.getByRole("link", { name: "New library blueprint" }).click();
  await page.getByLabel("Blueprint name").fill("talk");
  await page
    .getByRole("combobox", { name: "Check against deck" })
    .selectOption({ label: "Brief a Decision" });

  // The starter has cover (template cover) and point (1 to 5). Make point 3 to 6 with allowed kinds.
  await page.getByLabel("Step 2 min").fill("3");
  await page.getByLabel("Step 2 max").fill("6");
  for (const kind of ["heading", "paragraph", "list"]) await page.getByLabel(`point allow: ${kind}`).click();

  // A conclusion type, renamed from its default name, and a page step for it.
  await page.getByRole("button", { name: "Add type" }).click();
  const fresh = card(page, "type-type-3");
  await fresh.getByLabel("Type name").fill("conclusion");
  await fresh.getByLabel("Type name").press("Enter");
  const conclusion = card(page, "type-conclusion");
  await conclusion.getByLabel("conclusion template").selectOption("summary");
  await conclusion.getByLabel("conclusion allow: heading").click();
  await conclusion.getByLabel("conclusion allow: paragraph").click();
  await conclusion.getByLabel("conclusion max chars").fill("250");
  await page.getByRole("button", { name: "Add page step" }).click();
  await page.getByLabel("Step 3 type").selectOption("conclusion");

  await expect(page.getByTestId("deck-check")).toContainText("Every slide passes.");
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page).toHaveURL(/\/kits\/blueprints\/library\/talk$/);

  const file = path.join(LIBRARY, "blueprints/talk.yml");
  const written = await fs.readFile(file, "utf8");
  const expected = parse(await fs.readFile(path.join(WORKSPACE, "blueprint-talk/blueprint.yml"), "utf8"));
  expect(parse(written)).toEqual(expected);

  test.skip(!CLI, "flipbook-md CLI not found next to this repo; set FLIPBOOK_CLI");
  const deck = await fs.mkdtemp(path.join(os.tmpdir(), "studio-bp-"));
  await fs.cp(path.join(WORKSPACE, "blueprint-talk"), deck, { recursive: true });
  await fs.writeFile(path.join(deck, "blueprint.yml"), written);
  const check = spawnSync(process.execPath, [CLI!, "check", deck], { encoding: "utf8" });
  expect(check.stderr).toBe("");
  expect(check.status).toBe(0);
});

test("lowering conclusion max_chars in a deck's blueprint flags the conclusion slide live", async ({
  page,
}) => {
  await page.goto(`${STUDIO}kits/blueprints/deck/${TALK}`);
  await expect(page.getByTestId("deck-check")).toContainText("Every slide passes.");
  await card(page, "type-conclusion").getByLabel("conclusion max chars").fill("40");
  await expect(page.getByTestId("deck-check")).toContainText("1 slide(s) would fail");
  await expect(page.getByTestId("deck-check")).toContainText(
    "slides/05_conclusion.slide.md: visible text is",
  );
  await expect(page.getByTestId("deck-check")).toContainText("maximum is 40.");

  // Inline problems show before saving: max below min.
  await page.getByLabel("Step 2 max").fill("2");
  await expect(card(page, "step-2")).toContainText("Repeat max can't be below min.");
  await expect(save(page)).toBeDisabled();
  await page.getByLabel("Step 2 max").fill("6");
  await expect(save(page)).toBeEnabled();

  // A form save is a patch: one line changes in the deck's file.
  const file = path.join(WORKSPACE, "blueprint-talk/blueprint.yml");
  const before = await fs.readFile(file, "utf8");
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  await expect.poll(() => fs.readFile(file, "utf8")).toBe(before.replace("max_chars: 250", "max_chars: 40"));
});

test("an unknown template typed in the raw YAML is flagged and blocks saving", async ({ page }) => {
  await page.goto(`${STUDIO}kits/blueprints/library/talk`);
  await page.getByRole("tab", { name: "Raw YAML" }).click();
  const source = await fs.readFile(path.join(LIBRARY, "blueprints/talk.yml"), "utf8");
  await page.getByLabel("Blueprint YAML").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(source.replace("template: summary", "template: nowhere"));
  await expect(page.getByTestId("save-reason")).toHaveText('Unknown template "nowhere".');
  await expect(save(page)).toBeDisabled();
  await page.getByRole("tab", { name: "Form" }).click();
  await expect(card(page, "type-conclusion")).toContainText('Unknown template "nowhere".');
  await expect(card(page, "type-conclusion").getByLabel("conclusion template")).toHaveValue("nowhere");
  expect(await fs.readFile(path.join(LIBRARY, "blueprints/talk.yml"), "utf8")).toBe(source);
});

test("renaming a type updates the pages that use it, and pages reorder by keyboard", async ({ page }) => {
  await page.goto(`${STUDIO}kits/blueprints/library/talk`);
  const point = card(page, "type-point");
  await point.getByLabel("Type name").fill("idea");
  await point.getByLabel("Type name").press("Enter");
  await expect(page.getByLabel("Step 2 type")).toHaveValue("idea");
  await page.getByRole("button", { name: "Move page step 3", exact: true }).focus();
  // dnd-kit measures the list between steps, so give each key a moment.
  for (const key of ["Space", "ArrowUp", "Space"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  await expect(page.getByLabel("Step 2 type")).toHaveValue("conclusion");
  await expect(page.getByLabel("Step 3 type")).toHaveValue("idea");
});
