import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4393/";
const WORKSPACE = path.resolve(".e2e-workspace");

/** `flipbook check`: FLIPBOOK_CLI, else a sibling flipbook-md checkout, else CLI 0.4.0 from npm (CI). */
function flipbookCheck(target: string) {
  const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
  const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
  const [command, args] = cli ? [process.execPath, [cli]] : ["npx", ["--yes", "flipbook-md@0.4.0"]];
  return spawnSync(command, [...args, "check", target], {
    encoding: "utf8",
    env: { ...process.env, FLIPBOOK_HOME: path.resolve("fixtures/library") },
  });
}

async function openDialog(page: Page) {
  await page.goto(STUDIO);
  await page.getByRole("button", { name: "New deck" }).first().click();
  return page.getByRole("dialog", { name: "New deck" });
}

test.describe.configure({ mode: "serial" });

test("creates a blank folder deck from the empty state and opens it", async ({ page }) => {
  await page.goto(STUDIO);
  await page.getByTestId("empty-state").getByRole("button", { name: "New deck" }).click();
  const dialog = page.getByRole("dialog", { name: "New deck" });
  await dialog.getByLabel("Title").fill("Quarterly review");
  await expect(dialog.getByLabel("Name")).toHaveValue("quarterly-review");
  await dialog.getByRole("button", { name: "Create deck" }).click();

  await expect(page).toHaveURL(/\/decks\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quarterly review");
  await expect(page.getByTestId("slide-thumb")).toHaveCount(1);

  const check = flipbookCheck(path.join(WORKSPACE, "quarterly-review"));
  expect(check.status, check.stderr).toBe(0);
});

test("creates a single-file deck from a kit with its placeholder slides", async ({ page }) => {
  const dialog = await openDialog(page);
  await dialog.getByLabel("Title").fill("Places to visit");
  await dialog.getByLabel("Single file").check();
  await dialog.getByRole("radio", { name: /marvel_content_place/ }).check();
  await dialog.getByRole("button", { name: "Create deck" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Places to visit");
  // marvel_content_place requires cover and toc; content is optional.
  await expect(page.getByTestId("slide-thumb")).toHaveCount(2);

  const check = flipbookCheck(path.join(WORKSPACE, "places-to-visit.slide.md"));
  expect(check.status, check.stderr).toBe(0);
  expect(check.stdout).toMatch(/2 slide\(s\) match marvel_content_place/);
});

test("shows an inline error for a taken name and keeps the dialog open", async ({ page }) => {
  const dialog = await openDialog(page);
  await dialog.getByLabel("Title").fill("Quarterly review");
  await dialog.getByRole("button", { name: "Create deck" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await expect(dialog.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(STUDIO);

  await dialog.getByLabel("Name").fill("quarterly-review-2");
  await dialog.getByRole("button", { name: "Create deck" }).click();
  await expect(page).toHaveURL(/\/decks\//);
});

test("the workspace lists the new decks", async ({ page }) => {
  await page.goto(STUDIO);
  await expect(page.getByTestId("deck-card")).toHaveCount(3);
});
