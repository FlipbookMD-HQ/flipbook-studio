import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4394/";
const WORKSPACE = path.resolve(".e2e-edit");
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const TALK = id("blueprint-talk");
const CONCLUSION = "slides/05_conclusion.slide.md";
const ORIGINAL = "# Ask for the yes\n\nName the owner, the option, and the date. Stop there.";
const MESSAGE = /^slides\/05_conclusion\.slide\.md: visible text is \d+ characters; maximum is 250\.$/;

/** `flipbook check`'s output lines: FLIPBOOK_CLI, else a sibling flipbook-md checkout, else null. */
function flipbookCheck(target: string): string[] | null {
  const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
  const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
  if (!cli) return null;
  const run = spawnSync(process.execPath, [cli, "check", target], {
    encoding: "utf8",
    env: { ...process.env, FLIPBOOK_HOME: path.resolve("fixtures/library") },
  });
  return run.stderr.trim().split("\n").filter(Boolean);
}

async function setMarkdown(page: Page, text: string) {
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

const panel = (page: Page) => page.getByTestId("check-panel");

test.describe.configure({ mode: "serial" });

test("breaking a rule shows the CLI message on the slide, in the list and in the header", async ({
  page,
}) => {
  await page.goto(`${STUDIO}decks/${TALK}/slides/${encodeURIComponent(CONCLUSION)}`);
  await expect(panel(page)).toHaveText("Matches the blueprint.");

  await setMarkdown(page, `${ORIGINAL}\n\n${"More words that push the slide past its limit. ".repeat(5)}`);
  const inline = page.getByTestId("slide-violations");
  await expect(inline).toHaveCount(1);
  await expect(inline.getByRole("listitem")).toHaveText([MESSAGE]);
  await expect(panel(page).getByRole("heading")).toHaveText("1 blueprint issue");
  await expect(panel(page).getByRole("listitem")).toHaveText([MESSAGE]);
  const row = page.getByTestId("slide-row").filter({ hasText: "5." });
  await expect(row.getByTestId("violation-badge")).toHaveText("1");

  // Saved, the message is word-for-word what `flipbook check` prints.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const shown = await inline.getByRole("listitem").allTextContents();
  const cli = flipbookCheck(path.join(WORKSPACE, "blueprint-talk"));
  if (cli) expect(shown).toEqual(cli);
});

test("clicking a violation in the deck header opens its slide; fixing it clears on the next preview", async ({
  page,
}) => {
  await page.goto(`${STUDIO}decks/${TALK}`);
  await expect(page.getByTestId("violation-badge")).toHaveText(["1"]);
  await panel(page).getByRole("link", { name: MESSAGE }).click();
  await expect(page).toHaveURL(`${STUDIO}decks/${TALK}/slides/${encodeURIComponent(CONCLUSION)}`);
  await expect(page.getByTestId("slide-violations")).toBeVisible();

  // Unsaved fix: the warning clears from the preview's check alone.
  await setMarkdown(page, ORIGINAL);
  await expect(page.getByTestId("slide-violations")).toHaveCount(0);
  await expect(panel(page)).toHaveText("Matches the blueprint.");
  await expect(page.getByTestId("violation-badge")).toHaveCount(0);
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await expect(panel(page)).toHaveText("Matches the blueprint.");
});

test("a deck with no blueprint shows no check UI", async ({ page }) => {
  await page.goto(`${STUDIO}decks/${id("system-design.slide.md")}`);
  await expect(page.getByTestId("slide-thumb").first()).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.goto(`${STUDIO}decks/${id("system-design.slide.md")}/slides/${encodeURIComponent("#1")}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await setMarkdown(page, "# Anything\n\n```\ncode\n```");
  await expect(page.frameLocator('[data-testid="preview"]').getByText("Anything")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("slide-violations")).toHaveCount(0);
  await expect(page.getByTestId("violation-badge")).toHaveCount(0);
});
