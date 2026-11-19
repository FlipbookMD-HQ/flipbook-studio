import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startStudio, stopStudio } from "./support/studio";

// US-23: Save version and the timeline, on a Studio of its own (port 4410) whose workspace is
// a temp folder outside any repository, with a HOME and git config of its own (no author).
const DECK = Buffer.from("talk", "utf8").toString("base64url");
const S3 = "slides/03_point.slide.md";

let root: string;
let workspace: string;
let gitEnv: NodeJS.ProcessEnv;
let studio: Awaited<ReturnType<typeof startStudio>> | null = null;

async function start(extra: NodeJS.ProcessEnv = {}) {
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700, recursive: true });
  studio = await startStudio(workspace, configDir, 4410, path.join(root, "library"), { ...gitEnv, ...extra });
  return studio;
}

test.beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "studio-history-")));
  workspace = path.join(root, "ws");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), path.join(workspace, "talk"), { recursive: true });
  const home = path.join(root, "home");
  await fs.mkdir(home);
  gitEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
});
test.afterEach(async () => {
  if (studio) await stopStudio(studio.child);
  studio = null;
});

const panel = (page: Page) => page.getByTestId("history-panel");
async function openHistory(page: Page) {
  await page.getByRole("button", { name: "History" }).click();
  await expect(panel(page)).toBeVisible();
}

test("init, save a first draft, edit a slide, save again: two versions", async ({ page }) => {
  const { url } = await start();
  await page.goto(`${url}decks/${DECK}`);
  await openHistory(page);
  await expect(panel(page)).toHaveAttribute("data-state", "no-repo");

  // The first Save version only offers git init, naming where the repository would go.
  await panel(page).getByRole("button", { name: "Save version" }).click();
  const offer = page.getByTestId("history-init-offer");
  await expect(offer).toContainText(path.join(workspace, "talk"));
  await expect(offer).toContainText(workspace);
  await expect(fs.access(path.join(workspace, "talk", ".git"))).rejects.toThrow();
  await offer.getByRole("button", { name: /Set up git in the deck's folder/ }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("history-repo-root")).toHaveText(path.join(workspace, "talk"));

  await panel(page).getByLabel("Note (optional)").fill("first draft");
  await panel(page).getByRole("button", { name: "Save version" }).click();
  // No author in git config: asked once, saved to Studio's settings.
  const author = page.getByTestId("history-author");
  await author.getByLabel("Name").fill("Ada Lovelace");
  await author.getByLabel("Email").fill("ada@example.com");
  await author.getByRole("button", { name: "Save author and version" }).click();
  await expect(page.getByTestId("history-version")).toHaveCount(1);
  await expect(page.getByTestId("history-version").first()).toContainText("first draft");
  await expect(panel(page).getByRole("button", { name: "Save version" })).toBeDisabled();
  await expect(page.getByTestId("history-save-blocked")).toHaveText("No changes since first draft");

  // Edit a slide in the editor, then save a second version from there.
  await page.goto(`${url}decks/${DECK}/slides/${encodeURIComponent(S3)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nA new line.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await openHistory(page);
  await expect(page.getByTestId("history-changes")).toContainText("1 file changed since “first draft”");
  await panel(page).getByLabel("Note (optional)").fill("second");
  await panel(page).getByRole("button", { name: "Save version" }).click();
  await expect(page.getByTestId("history-version")).toHaveCount(2);
  await expect(page.getByTestId("history-version").first()).toContainText("second");
  await expect(page.getByTestId("history-version").first()).toContainText("1 slide changed");
  await expect(page.getByTestId("history-version").nth(1)).toContainText("first draft");

  const log = execFileSync("git", ["log", "--format=%s|%an"], {
    cwd: path.join(workspace, "talk"),
    env: { ...process.env, ...gitEnv },
    encoding: "utf8",
  });
  expect(log.trim().split("\n")).toEqual(["second|Ada Lovelace", "first draft|Ada Lovelace"]);
});

test("without git, History is disabled with its reason and editing still works", async ({ page }) => {
  const { url } = await start({ PATH: path.join(root, "no-bin") });
  await page.goto(`${url}decks/${DECK}/slides/${encodeURIComponent(S3)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await openHistory(page);
  await expect(panel(page)).toHaveAttribute("data-state", "no-git");
  await expect(page.getByTestId("history-state")).toContainText("History is off: Git isn't installed");
  await expect(panel(page).getByRole("button", { name: "Save version" })).toBeDisabled();

  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nStill editable.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect(await fs.readFile(path.join(workspace, "talk", S3), "utf8")).toContain("Still editable.");
});
