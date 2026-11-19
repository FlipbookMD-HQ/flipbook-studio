import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startStudio, stopStudio } from "./support/studio";

// US-27: restore one slide from a version, in the History panel's version view, on a Studio of
// its own (port 4415) whose deck is a git repository in a temp folder, with a HOME and git
// config of its own.
const DECK = Buffer.from("talk", "utf8").toString("base64url");
const S2 = "slides/02_point.slide.md";
const S3 = "slides/03_point.slide.md";

let root: string;
let deckDir: string;
let gitEnv: NodeJS.ProcessEnv;
let studio: Awaited<ReturnType<typeof startStudio>> | null = null;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: deckDir, env: { ...process.env, ...gitEnv }, encoding: "utf8" });
const read = (relative: string) => fs.readFile(path.join(deckDir, relative), "utf8");
const exists = (relative: string) =>
  fs.access(path.join(deckDir, relative)).then(
    () => true,
    () => false,
  );

test.beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "studio-restore-slide-")));
  deckDir = path.join(root, "ws", "talk");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), deckDir, { recursive: true });
  const home = path.join(root, "home");
  await fs.mkdir(home);
  gitEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700, recursive: true });
  studio = await startStudio(path.join(root, "ws"), configDir, 4415, path.join(root, "library"), gitEnv);
});
test.afterEach(async () => {
  if (studio) await stopStudio(studio.child);
  studio = null;
});

const panel = (page: Page) => page.getByTestId("history-panel");
const rows = (page: Page) => page.getByTestId("slide-row");
const undoButton = (page: Page) => page.getByTestId("undo-controls").getByRole("button", { name: /^Undo/ });
const entry = (page: Page, note: string) =>
  page
    .getByTestId("history-version")
    .filter({ has: page.locator("strong", { hasText: new RegExp(`^${note}$`) }) });
const versionSlide = (page: Page, n: number) => page.getByTestId("version-slide").nth(n - 1);

async function openHistory(page: Page) {
  if (!(await panel(page).isVisible())) await page.getByRole("button", { name: "History" }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
async function openSlide(page: Page, slideId: string) {
  await page.goto(`${studio!.url}decks/${DECK}/slides/${encodeURIComponent(slideId)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
async function viewVersion(page: Page, note: string) {
  await openHistory(page);
  if (!(await page.getByTestId("version-view").isVisible()))
    await entry(page, note).getByRole("button", { name: "View slides" }).click();
  await expect(page.getByTestId("version-slide")).toHaveCount(5);
}

test("save v1, edit slide 2 and delete slide 3, restore both from v1: order and content come back", async ({
  page,
}) => {
  const manifest = await read("presentation.yml");
  const s2 = await read(S2);
  const s3 = await read(S3);

  // v1, saved from the History panel.
  await openSlide(page, S2);
  await openHistory(page);
  await panel(page).getByLabel("Note (optional)").fill("v1");
  await panel(page).getByRole("button", { name: "Save version" }).click();
  await expect(entry(page, "v1")).toBeVisible();
  await panel(page).getByRole("button", { name: "Close" }).click();
  const head = git("rev-parse", "HEAD").trim();

  // Edit slide 2 and save it.
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nEdited after v1.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect(await read(S2)).toContain("Edited after v1.");

  // Delete slide 3.
  await openSlide(page, S3);
  await page.getByRole("button", { name: "Delete slide" }).click();
  await page.getByRole("dialog", { name: "Delete slide 3?" }).getByRole("button", { name: "Delete" }).click();
  await expect(rows(page)).toHaveCount(4);
  expect(await exists(S3)).toBe(false);

  // The version view marks slide 2 changed and slide 3 gone, with previews.
  await viewVersion(page, "v1");
  await expect(versionSlide(page, 1)).toHaveAttribute("data-status", "same");
  await expect(versionSlide(page, 2)).toHaveAttribute("data-status", "changed");
  await expect(versionSlide(page, 3)).toHaveAttribute("data-status", "gone");
  await expect(page.getByTestId("version-preview")).toHaveCount(5);
  await expect(versionSlide(page, 1).getByRole("button", { name: /Restore slide 1/ })).toBeDisabled();
  await expect
    .poll(() => versionSlide(page, 3).getByTestId("version-preview").getAttribute("srcdoc"))
    .toContain("Show the limit");

  // Restore slide 2: its content replaces the current one; the editor shows it.
  await versionSlide(page, 2)
    .getByRole("button", { name: /Restore slide 2/ })
    .click();
  await expect(page.getByTestId("slide-restored")).toContainText("Restored slide “Name the decision”");
  await expect(undoButton(page)).toHaveAccessibleName('Undo: Restore slide "Name the decision"');
  await expect(page).toHaveURL(new RegExp(`/slides/${encodeURIComponent(S2)}$`));
  await expect(page.getByLabel("Markdown")).not.toContainText("Edited after v1.");
  expect(await read(S2)).toBe(s2);
  await expect(versionSlide(page, 2)).toHaveAttribute("data-status", "same");

  // Restore slide 3: it goes back at its old position, and the editor opens it.
  await versionSlide(page, 3)
    .getByRole("button", { name: /Restore slide 3/ })
    .click();
  await expect(page.getByTestId("slide-restored")).toContainText("Restored slide “Show the limit”");
  await expect(rows(page)).toHaveCount(5);
  await expect(page).toHaveURL(new RegExp(`/slides/${encodeURIComponent(S3)}$`));
  await expect(page.getByLabel("Markdown")).toContainText("Show the limit");
  await expect(undoButton(page)).toHaveAccessibleName('Undo: Restore slide "Show the limit"');
  expect(await read(S3)).toBe(s3);
  expect(await read("presentation.yml")).toBe(manifest);
  await expect(rows(page).nth(2)).toContainText("Show the limit");

  // No commit was made, and no version was added or deleted.
  expect(git("rev-parse", "HEAD").trim()).toBe(head);
  expect(git("log", "--format=%s").trim()).toBe("v1");

  // Each restore is one undo step: undo the last one and slide 3 is gone again.
  await undoButton(page).click();
  await expect(rows(page)).toHaveCount(4);
  expect(await exists(S3)).toBe(false);
  expect(await read(S2)).toBe(s2);
});

test("unsaved edits disable Restore this slide; a folder deck shows no position help", async ({ page }) => {
  git("add", "-A");
  git("commit", "-q", "-m", "v1");
  await fs.writeFile(path.join(deckDir, S2), "# Changed outside\n");

  await openSlide(page, S2);
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("x");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await viewVersion(page, "v1");
  const restore = versionSlide(page, 2).getByRole("button", { name: /Restore slide 2/ });
  await expect(restore).toBeDisabled();
  await expect(restore).toHaveAttribute("title", "Save or discard your edits first");
  await expect(page.getByTestId("slide-restore-blocked")).toContainText("Save or discard your edits first");
  await expect(page.getByTestId("version-single-help")).toHaveCount(0);

  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await expect(restore).toBeEnabled();
});

test("a single-file deck: help text, and a gone slide is appended", async ({ page }) => {
  const solo = path.join(root, "ws", "solo.slide.md");
  const text = "---\ntitle: Solo\n---\n# One\n\nHello.\n\n---\n\n# Two\n\nWorld.\n";
  await fs.writeFile(solo, text);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: path.join(root, "ws"),
    env: { ...process.env, ...gitEnv },
  });
  const wsGit = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
      cwd: path.join(root, "ws"),
      env: { ...process.env, ...gitEnv },
      encoding: "utf8",
    });
  wsGit("add", "solo.slide.md");
  wsGit("commit", "-q", "-m", "solo v1", "--", "solo.slide.md");
  await fs.writeFile(solo, "---\ntitle: Solo\n---\n# One\n\nHello.\n");

  const id = Buffer.from("solo.slide.md", "utf8").toString("base64url");
  await page.goto(`${studio!.url}decks/${id}/slides/${encodeURIComponent("#0")}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await openHistory(page);
  await entry(page, "solo v1").getByRole("button", { name: "View slides" }).click();
  await expect(page.getByTestId("version-single-help")).toContainText("matched by position");
  await expect(page.getByTestId("version-slide").nth(1)).toHaveAttribute("data-status", "gone");
  await page
    .getByTestId("version-slide")
    .nth(1)
    .getByRole("button", { name: /Restore slide 2/ })
    .click();
  await expect(page.getByTestId("slide-restored")).toContainText("Restored slide “Two”");
  await expect(page).toHaveURL(new RegExp(`/slides/${encodeURIComponent("#1")}$`));
  expect(await fs.readFile(solo, "utf8")).toBe(text);
});
