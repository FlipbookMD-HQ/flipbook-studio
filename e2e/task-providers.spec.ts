import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { recordedText } from "../test/support/anthropic-fixtures";
import { startAnthropicStub, type AnthropicStub } from "../test/support/anthropic-stub";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-24: a task on a paid model, against the fake Anthropic server, on a Studio of its own (port 4412).
const KEY = "sk-ant-api03-e2e-task-providers-a1b2";
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const COVER = { type: "cover", markdown: "# Reading guide\n\n![Hero](image.png)\n\nWhere to start." };
const timeline = (title: string, items: string[]) => ({
  type: "timeline",
  markdown: `# ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`,
});
const DECK = [COVER, timeline("Phase One", ["Iron Man", "Thor"]), timeline("Phase Two", ["Avengers"])]
  .map((slide) => JSON.stringify(slide))
  .join("\n");

let local: LlmStub;
let anthropic: AnthropicStub;
let configDir: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

test.beforeEach(async () => {
  local = await startLlmStub({ script: { models: ["small", "big"] } });
  anthropic = await startAnthropicStub({
    apiKey: KEY,
    // Slow enough to see the notice while it runs.
    chat: () => ({ kind: "stream", events: recordedText(`${DECK}\n`), delayMs: 40 }),
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-task-providers-"));
  const workspace = path.join(root, "ws");
  configDir = path.join(root, "config");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "existing.slide.md"), "# Hello\n");
  await fs.mkdir(configDir, { mode: 0o700 });
  const settings = {
    version: 1,
    llm: {
      baseUrl: local.url,
      model: "small",
      apiKey: null,
      temperature: 0.2,
      timeoutMs: 10_000,
      maxRepairRounds: 0,
    },
    providers: [
      { id: "anthropic", kind: "anthropic", label: "Anthropic", baseUrl: anthropic.url, apiKey: KEY },
    ],
    lastWorkspace: null,
  };
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  studio = await startStudio(workspace, configDir, 4412, undefined, {
    FLIPBOOK_STUDIO_ANTHROPIC_URL: anthropic.url,
  });
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await anthropic.close();
  await local.close();
});

const saved = async () => JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
const generatePicker = (page: Page) => page.getByLabel("Model for Generate a deck");
async function openGenerate(page: Page, title: string) {
  await page.goto(studio.url);
  await page.getByRole("button", { name: "New deck" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New deck" });
  await dialog.getByRole("button", { name: "Generate with AI" }).click();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("marvel_content_guide").check();
  await dialog.getByLabel("Topic", { exact: true }).fill("Watching the Marvel films in order");
  return dialog;
}

test("Generate on Anthropic says so before and during the run; a removed provider fails with a link to Settings", async ({
  page,
}) => {
  // Assign Generate to a Claude model, grouped under Anthropic after the local models.
  await page.goto(`${studio.url}settings`);
  const picker = generatePicker(page);
  await expect(picker.locator("optgroup")).toHaveCount(2);
  await expect(picker.locator("optgroup").nth(0)).toHaveAttribute("label", "Local");
  await expect(picker.locator("optgroup").nth(1)).toHaveAttribute("label", "Anthropic");
  await expect(picker.locator("option").first()).toHaveText("Same as default (small)");
  await expect(picker.locator('optgroup[label="Anthropic"] option')).toHaveCount(3);
  await picker.selectOption({ label: "claude-sonnet-4-5" });
  await expect(page.getByTestId("task-sends-generate")).toHaveText("Sends this task's content to Anthropic.");
  await expect(page.getByTestId("task-sends-chat")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect((await saved()).llm.taskModels).toEqual({
    generate: { provider: "anthropic", model: "claude-sonnet-4-5" },
  });

  // Before the run: the Generate button names the model and where it sends the content.
  const dialog = await openGenerate(page, "Marvel guide");
  const action = dialog.getByTestId("ai-action").filter({ hasText: "Generate with AI" });
  await expect(action.getByTestId("ai-model")).toHaveText("claude-sonnet-4-5");
  await expect(action.getByTestId("sends-to")).toHaveText("Sends to Anthropic");

  // During the run: the progress panel says so, from the stream's start event.
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("generate-progress").getByTestId("sends-to")).toHaveText(
    "Sends to Anthropic",
  );
  await expect(page).toHaveURL(new RegExp(`/decks/${id("marvel-guide")}/slides/`));
  await expect(page.getByRole("link", { name: /Reading guide/ }).first()).toBeVisible();
  const messages = anthropic.requests.filter((request) => request.path === "/v1/messages");
  expect(messages).toHaveLength(1);
  expect(messages[0]!.body).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 8192 });
  expect(local.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(0);

  // Local tasks show no notice: the slide editor's rewrite runs on the local default.
  const rewrite = page
    .getByTestId("ai-action")
    .filter({ has: page.getByRole("button", { name: "AI", exact: true }) });
  await expect(rewrite.getByTestId("ai-model")).toHaveText("small");
  await expect(rewrite.getByTestId("sends-to")).toHaveCount(0);

  // Remove the provider: its task model stays, marked, and the run fails with no fallback.
  await page.goto(`${studio.url}settings`);
  const card = page.getByTestId("provider-anthropic");
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await card.getByRole("button", { name: "Remove provider" }).click();
  await expect(page.getByTestId("provider-anthropic")).toHaveCount(0);
  await expect(page.getByTestId("task-model-missing-generate")).toContainText("which was removed");
  expect((await saved()).llm.taskModels.generate).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });

  const before = anthropic.requests.length;
  const again = await openGenerate(page, "Second guide");
  await again.getByRole("button", { name: "Generate", exact: true }).click();
  const progress = page.getByTestId("generate-progress");
  const error = progress.getByRole("alert");
  await expect(error).toContainText("Generate a deck uses anthropic, which was removed.");
  await expect(progress.getByTestId("sends-to")).toHaveCount(0);
  expect(anthropic.requests).toHaveLength(before);
  expect(local.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(0);
  await error.getByRole("link", { name: "Choose a model in Settings" }).click();
  await expect(page).toHaveURL(/\/settings#routing$/);
  await expect(generatePicker(page)).toBeVisible();
});
