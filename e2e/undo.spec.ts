import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-17: undo and redo, on a Studio of its own (port 4406) with the LLM stub for the chat.
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const DECK = id("talk");
const S3 = "slides/03_point.slide.md";
const REPLY: LlmFixture = {
  kind: "text",
  text: [
    "I shortened slide 3.",
    "```flipbook-ops",
    JSON.stringify([
      { kind: "updateSlide", slideId: S3, draft: { markdown: "# Show the limit\n\nShort now." } },
    ]),
    "```",
  ].join("\n"),
};

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 200)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let stub: LlmStub;
let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

test.beforeEach(async () => {
  stub = await startLlmStub({ script: { models: ["stub-model"], chat: () => REPLY } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-undo-"));
  workspace = path.join(root, "ws");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), path.join(workspace, "talk"), { recursive: true });
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  const llm = {
    baseUrl: stub.url,
    model: "stub-model",
    apiKey: null,
    temperature: 0.2,
    timeoutMs: 5_000,
    maxRepairRounds: 1,
  };
  await fs.writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({ version: 1, llm, lastWorkspace: null }),
    {
      mode: 0o600,
    },
  );
  studio = await startStudio(workspace, configDir, 4406, path.join(root, "library"));
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

/** Every file in the deck with its bytes (base64). */
async function snapshot(): Promise<Record<string, string>> {
  const dir = path.join(workspace, "talk");
  const out: Record<string, string> = {};
  for (const name of (await fs.readdir(dir, { recursive: true })).map(String).sort()) {
    const file = path.join(dir, name);
    if ((await fs.stat(file)).isFile()) out[name] = (await fs.readFile(file)).toString("base64");
  }
  return out;
}
const slideFile = (slide: string) => fs.readFile(path.join(workspace, "talk", slide), "utf8");
async function openSlide(page: Page, slide: string) {
  await page.goto(`${studio.url}decks/${DECK}/slides/${encodeURIComponent(slide)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
const undoButton = (page: Page) => page.getByTestId("undo-controls").getByRole("button", { name: /^Undo/ });
const redoButton = (page: Page) => page.getByTestId("undo-controls").getByRole("button", { name: /^Redo/ });

test("a slide save undoes and redoes byte-for-byte, and the editor shows each version", async ({ page }) => {
  const before = await snapshot();
  await openSlide(page, S3);
  await expect(undoButton(page)).toBeDisabled();
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nOne more line.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const after = await snapshot();

  await expect(undoButton(page)).toHaveAccessibleName("Undo: Edit slide 3");
  await undoButton(page).click();
  await expect(redoButton(page)).toHaveAccessibleName("Redo: Edit slide 3");
  expect(await snapshot()).toEqual(before);
  await expect(page.getByLabel("Markdown")).not.toContainText("One more line.");

  await redoButton(page).click();
  await expect(undoButton(page)).toHaveAccessibleName("Undo: Edit slide 3");
  expect(await snapshot()).toEqual(after);
  await expect(page.getByLabel("Markdown")).toContainText("One more line.");
});

test("reorder and delete undo in order, from the keyboard outside the editor", async ({ page }) => {
  const start = await snapshot();
  await openSlide(page, S3);
  await page.getByRole("button", { name: /^Move slide 3\./ }).focus();
  for (const key of ["Space", "ArrowUp", "Space"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  await expect(undoButton(page)).toHaveAccessibleName("Undo: Reorder slides");
  const reordered = await snapshot();

  await page.getByRole("button", { name: "Delete slide" }).click();
  await page
    .getByRole("dialog", { name: /^Delete slide \d\?$/ })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(undoButton(page)).toHaveAccessibleName(/^Undo: Delete slide \d$/);

  await page.locator("h1, .editor-bar").first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(undoButton(page)).toHaveAccessibleName("Undo: Reorder slides");
  expect(await snapshot()).toEqual(reordered);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(redoButton(page)).toHaveAccessibleName("Redo: Reorder slides");
  expect(await snapshot()).toEqual(start);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(undoButton(page)).toHaveAccessibleName("Undo: Reorder slides");
  expect(await snapshot()).toEqual(reordered);
});

test("an accepted AI proposal undoes as one step", async ({ page }) => {
  const before = await snapshot();
  await openSlide(page, "slides/01_cover.slide.md");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByLabel("Message").fill("Shorten slide 3");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("op-card").first()).toHaveAttribute("data-state", "applied");
  expect(await slideFile(S3)).toContain("Short now.");
  await expect(undoButton(page)).toHaveAccessibleName("Undo: AI: I shortened slide 3.");
  await undoButton(page).click();
  await expect(redoButton(page)).toHaveAccessibleName("Redo: AI: I shortened slide 3.");
  expect(await snapshot()).toEqual(before);
});

test("an image upload undoes from the deck screen", async ({ page }) => {
  const before = await snapshot();
  await page.goto(`${studio.url}decks/${DECK}`);
  await page
    .getByLabel("Image files")
    .setInputFiles([{ name: "Logo.png", mimeType: "image/png", buffer: png() }]);
  await expect(page.getByTestId("image-card")).toHaveCount(1);
  await expect(undoButton(page)).toHaveAccessibleName("Undo: Upload logo.png");
  await undoButton(page).click();
  await expect(page.getByTestId("images-empty")).toBeVisible();
  expect(await snapshot()).toEqual(before);
});

test("an outside edit blocks the undo and nothing is written", async ({ page }) => {
  await openSlide(page, S3);
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nStudio line.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await fs.writeFile(path.join(workspace, "talk", S3), "# Edited by hand\n");
  await undoButton(page).click();
  await expect(page.getByTestId("undo-error")).toContainText(
    "slides/03_point.slide.md changed outside Studio, so this can't be undone.",
  );
  expect(await slideFile(S3)).toBe("# Edited by hand\n");
});

test("unsaved edits disable Undo until they are saved", async ({ page }) => {
  await openSlide(page, S3);
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nFirst save.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(undoButton(page)).toBeEnabled();
  await page.keyboard.insertText(" Unsaved.");
  await expect(undoButton(page)).toBeDisabled();
  await expect(page.getByTestId("undo-blocked")).toHaveText("Save or discard your edits first");
  // Ctrl/Cmd+Z inside the editor is the editor's own text undo, not a file undo.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await slideFile(S3)).toContain("First save.");
});
