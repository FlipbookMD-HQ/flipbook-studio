import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4396/";
const WORKSPACE = path.resolve(".e2e-kits");
const LIBRARY = path.resolve(".e2e-library");
const BUILTIN = path.resolve("node_modules/@flipbook-md/core/library/themes/marvel-jarvis.css");
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");

test.describe.configure({ mode: "serial" });

const preview = (page: Page) => page.getByTestId("theme-preview");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

test("editing a built-in theme's accent updates all five samples and saves as a copy", async ({ page }) => {
  const before = await fs.readFile(BUILTIN, "utf8");
  await page.goto(`${STUDIO}kits/themes`);
  await page.getByRole("link", { name: "marvel-jarvis" }).click();
  await expect(page.getByText("Built-in — save as copy")).toBeVisible();
  await expect(preview(page)).toBeVisible();

  await page.getByLabel("--slide-accent", { exact: true }).fill("#ff0055");
  await expect
    .poll(async () =>
      occurrences((await preview(page).getAttribute("srcdoc")) ?? "", "--slide-accent: #ff0055"),
    )
    .toBe(5);
  const frame = page.frameLocator('[data-testid="theme-preview"]');
  await expect(frame.locator("[data-sample]")).toHaveCount(5);

  await page.getByRole("button", { name: "Save as copy…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as copy" });
  await dialog.getByLabel("Name of the library theme").fill("e2e-dusk");
  await dialog.getByRole("button", { name: "Save copy" }).click();
  await expect(page).toHaveURL(`${STUDIO}kits/themes/library/e2e-dusk`);
  await expect(page.getByText("Built-in — save as copy")).toHaveCount(0);

  const copy = await fs.readFile(path.join(LIBRARY, "themes/e2e-dusk.css"), "utf8");
  expect(copy).toBe(before.replace("--slide-accent: #7eefff", "--slide-accent: #ff0055"));
  expect(await fs.readFile(BUILTIN, "utf8")).toBe(before);
  await page.goto(`${STUDIO}kits/themes`);
  await expect(page.getByRole("listitem").filter({ hasText: "e2e-dusk" })).toContainText("Library");
});

test("a saved library theme shows on a deck with style: <name>", async ({ page }) => {
  await fs.writeFile(
    path.join(WORKSPACE, "styled.slide.md"),
    "---\ntitle: Styled\nstyle: e2e-dusk\n---\n# Styled deck\n",
  );
  await page.goto(`${STUDIO}kits/themes/library/e2e-dusk`);
  await page.getByLabel("--slide-accent", { exact: true }).fill("#00ff88");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  expect(await fs.readFile(path.join(LIBRARY, "themes/e2e-dusk.css"), "utf8")).toContain(
    "--slide-accent: #00ff88",
  );

  await page.goto(`${STUDIO}decks/${id("styled.slide.md")}`);
  const thumb = page.getByTitle("Slide 1: Styled deck");
  await expect
    .poll(async () => (await thumb.getAttribute("srcdoc")) ?? "")
    .toContain("--slide-accent: #00ff88");
});

test("editing a deck theme writes presentation.css, changing only the value", async ({ page }) => {
  const file = path.join(WORKSPACE, "themed-deck/presentation.css");
  const original = await fs.readFile(file, "utf8");
  await page.goto(`${STUDIO}kits/themes`);
  await page.getByRole("link", { name: "Themed deck (presentation.css)" }).click();
  await page.getByLabel("--accent", { exact: true }).fill("#123456");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  expect(await fs.readFile(file, "utf8")).toBe(original.replace("#33aa77", "#123456"));
});

test("broken CSS keeps the last good preview and can still be saved", async ({ page }) => {
  await page.goto(`${STUDIO}kits/themes/library/e2e-dusk`);
  await expect(preview(page)).toBeVisible();
  const good = await preview(page).getAttribute("srcdoc");
  await page.getByRole("tab", { name: "Raw CSS" }).click();
  await page.getByLabel("CSS").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n.broken {");
  await expect(page.getByTestId("css-warning")).toContainText("A { is not closed.");
  await page.waitForTimeout(400);
  expect(await preview(page).getAttribute("srcdoc")).toBe(good);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});
