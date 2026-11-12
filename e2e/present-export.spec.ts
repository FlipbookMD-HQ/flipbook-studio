import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4395/";
const WORKSPACE = path.resolve(".e2e-export");
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const TALK = id("blueprint-talk");
const CONCLUSION = path.join(WORKSPACE, "blueprint-talk/slides/05_conclusion.slide.md");

test.describe.configure({ mode: "serial" });

test("Present opens the player on the current slide and the announcer", async ({ page, context }) => {
  await page.goto(`${STUDIO}decks/${TALK}/slides/${encodeURIComponent("slides/03_point.slide.md")}`);
  const opened: string[] = [];
  context.on(
    "page",
    (tab) => void tab.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//).then(() => opened.push(tab.url())),
  );
  await page.getByRole("button", { name: "Present" }).click();
  await expect.poll(() => opened.length).toBe(2);
  const player = opened.find((url) => url.includes("?slide="))!;
  expect(player).toMatch(/\?slide=3$/);
  expect(opened.find((url) => url.endsWith("/announcer"))).toBeTruthy();
  expect(new URL(player).port).not.toBe("4395");

  const playerTab = context.pages().find((tab) => tab.url() === player)!;
  await expect(playerTab.locator("body")).toContainText("Show the limit");
});

test("an Instagram PNG export shows progress and writes one PNG per slide", async ({ page }) => {
  await page.goto(`${STUDIO}decks/${TALK}`);
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByLabel("Preset").selectOption("instagram");
  await dialog.getByLabel("Output folder (in the workspace)").fill("exports/e2e-instagram");
  await dialog.getByRole("button", { name: "Start export" }).click();
  await expect(dialog.getByTestId("export-status")).toContainText("Done: 6 files in exports/e2e-instagram", {
    timeout: 60_000,
  });
  const files = await fs.readdir(path.join(WORKSPACE, "exports/e2e-instagram"));
  expect(files.filter((name) => name.endsWith(".png"))).toHaveLength(5);
  expect(files).toContain("README.txt");
});

test("a deck that breaks its blueprint can't be exported and lists the violations", async ({ page }) => {
  const original = await fs.readFile(CONCLUSION, "utf8");
  await fs.writeFile(CONCLUSION, `# Ask\n\n${"Name the owner, the option, and the date. ".repeat(8)}\n`);
  try {
    await page.goto(`${STUDIO}decks/${TALK}`);
    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog", { name: "Export" });
    // The dialog reopens on the last export, so its button reads "Export again".
    await dialog.getByRole("button", { name: "Export again" }).click();
    const blocked = dialog.getByTestId("export-blocked");
    await expect(blocked).toContainText("Fix the blueprint issues before exporting.");
    await expect(blocked).toContainText("slides/05_conclusion.slide.md");
    await expect(blocked).toContainText(/maximum is 250/);
  } finally {
    await fs.writeFile(CONCLUSION, original);
  }
});

test("a video export without ffmpeg shows the install command", async ({ page }) => {
  await page.goto(`${STUDIO}decks/${TALK}`);
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByLabel("MP4 video").check();
  await dialog.getByRole("button", { name: /Start export|Export again/ }).click();
  const missing = dialog.getByTestId("export-dependency");
  await expect(missing).toContainText("Export needs ffmpeg.");
  await expect(missing.getByTestId("install-command")).toHaveText(/ffmpeg/);
});
