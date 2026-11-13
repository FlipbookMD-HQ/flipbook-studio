import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-15: the deck chat against the LLM stub, on a Studio of its own (port 4404).
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const S3 = "slides/03_point.slide.md";
const SPLIT = [
  "I split slide 3 into two.",
  "```flipbook-ops",
  JSON.stringify([
    {
      kind: "updateSlide",
      slideId: S3,
      draft: { markdown: "# Show the limit\n\nA brief is a limit, not a tour of the subject." },
    },
    {
      kind: "addSlide",
      afterSlideId: S3,
      draft: {
        markdown: "# Name the trade-off\n\n- Time, money, or a date\n- The option you are not offering",
      },
    },
  ]),
  "```",
].join("\n");

let stub: LlmStub | null = null;
let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
let reply: LlmFixture;

async function boot(withLlm = true) {
  if (withLlm) stub = await startLlmStub({ script: { models: ["stub-model"], chat: () => reply } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-chat-"));
  workspace = path.join(root, "ws");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), path.join(workspace, "talk"), { recursive: true });
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  const llm = stub
    ? {
        baseUrl: stub.url,
        model: "stub-model",
        apiKey: null,
        temperature: 0.2,
        timeoutMs: 5_000,
        maxRepairRounds: 1,
      }
    : null;
  await fs.writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({ version: 1, llm, lastWorkspace: null }),
    { mode: 0o600 },
  );
  studio = await startStudio(workspace, configDir, 4404, path.join(root, "library"));
}
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub?.close();
  stub = null;
});

async function openChat(page: Page, slide = "slides/01_cover.slide.md") {
  await page.goto(`${studio.url}decks/${id("talk")}/slides/${encodeURIComponent(slide)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Chat" }).click();
}
async function ask(page: Page, message: string) {
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
}
const files = async () => {
  const dir = path.join(workspace, "talk");
  const names = (await fs.readdir(dir, { recursive: true })).map(String).sort();
  return Promise.all(
    names.map(async (name) => [name, await fs.readFile(path.join(dir, name), "utf8").catch(() => "")]),
  );
};

test("splitting slide 3 and accepting both edits gives one more slide", async ({ page }) => {
  reply = { kind: "text", text: SPLIT };
  await boot();
  await openChat(page);
  await ask(page, "Split slide 3 into two");
  await expect(page.getByTestId("chat-assistant")).toContainText("I split slide 3 into two.");
  await expect(page.getByTestId("op-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("op-card").first()).toHaveAttribute("data-state", "applied");
  await expect(page.getByRole("link", { name: /^\d+\. / })).toHaveCount(6);
  await expect(page.getByRole("link", { name: /4\. Name the trade-off/ })).toBeVisible();
  const slide3 = await fs.readFile(path.join(workspace, "talk", S3), "utf8");
  expect(slide3).toContain("A brief is a limit, not a tour of the subject.");
  expect(slide3).not.toContain("Time, money");
});

test("rejecting the edits changes nothing", async ({ page }) => {
  reply = { kind: "text", text: SPLIT };
  await boot();
  const before = await files();
  await openChat(page);
  await ask(page, "Split slide 3 into two");
  await expect(page.getByTestId("op-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByTestId("chat-closed")).toBeVisible();
  expect(await files()).toEqual(before);
});

test("an edit to a slide changed by hand after the proposal is stale", async ({ page }) => {
  reply = { kind: "text", text: SPLIT };
  await boot();
  await openChat(page, S3);
  await ask(page, "Split slide 3 into two");
  await expect(page.getByTestId("op-card")).toHaveCount(2);

  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nEdited by hand.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");

  const update = page.getByTestId("op-card").first();
  await expect(update).toHaveAttribute("data-state", "stale");
  await expect(update.getByRole("button", { name: "Accept" })).toHaveCount(0);
  expect(await fs.readFile(path.join(workspace, "talk", S3), "utf8")).toContain("Edited by hand.");
});

test("a text-only reply shows no review", async ({ page }) => {
  reply = { kind: "text", text: "The deck asks for a yes on one option, by a date." };
  await boot();
  await openChat(page);
  await ask(page, "What does the deck ask for?");
  await expect(page.getByTestId("chat-assistant")).toContainText("asks for a yes");
  await expect(page.getByTestId("proposal")).toHaveCount(0);
});

test("the chat is disabled without a model", async ({ page }) => {
  await boot(false);
  await page.goto(`${studio.url}decks/${id("talk")}/slides/${encodeURIComponent(S3)}`);
  const panel = page.getByRole("complementary", { name: "Deck chat" });
  await expect(panel.getByRole("button", { name: "Chat" })).toBeDisabled();
  await expect(panel.getByRole("link", { name: "Set up a local model" })).toBeVisible();
});
