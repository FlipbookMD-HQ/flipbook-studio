import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startStudio, stopStudio } from "./support/studio";

// US-26: Restore deck from the History panel, on a Studio of its own (port 4413) whose deck is a
// git repository in a temp folder, with a HOME and git config of its own.
const DECK = Buffer.from("talk", "utf8").toString("base64url");
const S1 = "slides/01_cover.slide.md";
const S2 = "slides/02_point.slide.md";
const S3 = "slides/03_point.slide.md";
const S4 = "slides/04_point.slide.md";

let root: string;
let deckDir: string;
let gitEnv: NodeJS.ProcessEnv;
let studio: Awaited<ReturnType<typeof startStudio>> | null = null;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: deckDir, env: { ...process.env, ...gitEnv }, encoding: "utf8" });
const commitAll = (note: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", note);
  return git("rev-parse", "HEAD").trim();
};
const read = (relative: string) => fs.readFile(path.join(deckDir, relative), "utf8");
const exists = (relative: string) =>
  fs.access(path.join(deckDir, relative)).then(
    () => true,
    () => false,
  );

test.beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "studio-restore-")));
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
  studio = await startStudio(path.join(root, "ws"), configDir, 4413, path.join(root, "library"), gitEnv);
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

async function openHistory(page: Page) {
  if (!(await panel(page).isVisible())) await page.getByRole("button", { name: "History" }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
async function saveVersion(page: Page, note: string) {
  await openHistory(page);
  await panel(page).getByLabel("Note (optional)").fill(note);
  await panel(page).getByRole("button", { name: "Save version" }).click();
  await expect(entry(page, note)).toBeVisible();
}
async function openSlide(page: Page, slideId: string) {
  await page.goto(`${studio!.url}decks/${DECK}/slides/${encodeURIComponent(slideId)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}

test("save v1, delete a slide, save v2, restore v1 (the slide is back), then undo (gone again)", async ({
  page,
}) => {
  await openSlide(page, S4);
  await saveVersion(page, "v1");
  await panel(page).getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Delete slide" }).click();
  await page.getByRole("dialog", { name: "Delete slide 4?" }).getByRole("button", { name: "Delete" }).click();
  await expect(rows(page)).toHaveCount(4);
  expect(await exists(S4)).toBe(false);
  await saveVersion(page, "v2");
  const head = git("rev-parse", "HEAD").trim();

  await entry(page, "v1").getByRole("button", { name: "Restore deck" }).click();
  const confirm = page.getByTestId("restore-confirm");
  await expect(confirm).toContainText("Restore the whole deck to “v1”?");
  await confirm.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("history-restored")).toContainText("Restored “v1”");
  await expect(rows(page)).toHaveCount(5);
  expect(await exists(S4)).toBe(true);
  await expect(undoButton(page)).toHaveAccessibleName('Undo: Restore "v1"');
  // No commit, and no version deleted.
  expect(git("rev-parse", "HEAD").trim()).toBe(head);
  await expect(page.getByTestId("history-version")).toHaveCount(2);

  await undoButton(page).click();
  await expect(rows(page)).toHaveCount(4);
  expect(await exists(S4)).toBe(false);
  expect(git("log", "--format=%s").trim().split("\n")).toEqual(["v2", "v1"]);
});

test("the dirty-deck dialog: Cancel, Discard my changes, Save version first", async ({ page }) => {
  const original = await read(S3);
  commitAll("v1");
  await fs.writeFile(path.join(deckDir, S3), `${original}\nAdded in v2.\n`);
  commitAll("v2");
  // Changes since v2: an edited slide and a new file.
  await fs.writeFile(path.join(deckDir, S2), "# Changed outside\n");
  await fs.writeFile(path.join(deckDir, "notes.md"), "scratch\n");
  const changedS2 = await read(S2);

  await page.goto(`${studio!.url}decks/${DECK}`);
  await openHistory(page);
  const dirty = page.getByTestId("restore-dirty");

  // Cancel: nothing changes.
  await entry(page, "v1").getByRole("button", { name: "Restore deck" }).click();
  await expect(dirty).toContainText("The deck has 2 changes since “v2”");
  await expect(page.getByTestId("discard-deletes")).toContainText("notes.md");
  await dirty.getByRole("button", { name: "Cancel" }).click();
  await expect(dirty).toBeHidden();
  expect(await read(S2)).toBe(changedS2);
  expect(await exists("notes.md")).toBe(true);

  // Discard my changes: the new file is deleted, then the deck is restored to v1.
  await entry(page, "v1").getByRole("button", { name: "Restore deck" }).click();
  await dirty.getByRole("button", { name: "Discard my changes" }).click();
  await expect(page.getByTestId("history-restored")).toContainText("Restored “v1”");
  expect(await exists("notes.md")).toBe(false);
  expect(await read(S3)).toBe(original);
  expect(await read(S2)).not.toBe(changedS2);
  await expect(undoButton(page)).toHaveAccessibleName('Undo: Restore "v1"');

  // Save version first: the changes become a version, then the deck is restored to v2.
  await expect(page.getByTestId("history-changes")).toBeVisible();
  await entry(page, "v2").getByRole("button", { name: "Restore deck" }).click();
  await panel(page).getByLabel("Note (optional)").fill("back at v1");
  await dirty.getByRole("button", { name: "Save version first" }).click();
  await expect(page.getByTestId("history-restored")).toContainText("Restored “v2”");
  await expect(page.getByTestId("history-version")).toHaveCount(3);
  expect(git("log", "--format=%s").trim().split("\n")).toEqual(["back at v1", "v2", "v1"]);
  expect(await read(S3)).toBe(`${original}\nAdded in v2.\n`);
});

test("unsaved edits disable Restore; a restore that removes the open slide moves to slide 1", async ({
  page,
}) => {
  const s4 = await read(S4);
  const manifest = await read("presentation.yml");
  await fs.rm(path.join(deckDir, S4));
  await fs.writeFile(path.join(deckDir, "presentation.yml"), manifest.replace(`  - "${S4}"\n`, ""));
  commitAll("four slides");
  await fs.writeFile(path.join(deckDir, S4), s4);
  await fs.writeFile(path.join(deckDir, "presentation.yml"), manifest);
  commitAll("five slides");

  await openSlide(page, S4);
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("x");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await openHistory(page);
  const restore = entry(page, "four slides").getByRole("button", { name: "Restore deck" });
  await expect(restore).toBeDisabled();
  await expect(restore).toHaveAttribute("title", "Save or discard your edits first");
  await expect(page.getByTestId("restore-blocked")).toContainText("Save or discard your edits first");

  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await expect(restore).toBeEnabled();
  await restore.click();
  await page.getByTestId("restore-confirm").getByRole("button", { name: "Restore" }).click();
  await expect(page).toHaveURL(new RegExp(`/slides/${encodeURIComponent(S1)}$`));
  await expect(rows(page)).toHaveCount(4);
  expect(await exists(S4)).toBe(false);
});

test("restoring a version whose files don't load shows the error with Undo, and Undo brings the deck back", async ({
  page,
}) => {
  const manifest = await read("presentation.yml");
  await fs.writeFile(path.join(deckDir, "presentation.yml"), "title: [unclosed\n");
  commitAll("broken");
  await fs.writeFile(path.join(deckDir, "presentation.yml"), manifest);
  commitAll("fixed");

  await page.goto(`${studio!.url}decks/${DECK}`);
  await expect(page.getByRole("heading", { name: "Brief a Decision", level: 1 }).first()).toBeVisible();
  await openHistory(page);
  await entry(page, "broken").getByRole("button", { name: "Restore deck" }).click();
  await page.getByTestId("restore-confirm").getByRole("button", { name: "Restore" }).click();

  // The restore happened; the deck screen says why it can't show the deck, and offers Undo.
  await expect(page.getByTestId("deck-load-undo-hint")).toBeVisible();
  expect(await read("presentation.yml")).toBe("title: [unclosed\n");
  await expect(undoButton(page)).toHaveAccessibleName('Undo: Restore "broken"');

  await undoButton(page).click();
  await expect(page.getByRole("heading", { name: "Brief a Decision", level: 1 }).first()).toBeVisible();
  expect(await read("presentation.yml")).toBe(manifest);
});
