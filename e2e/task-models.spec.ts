import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture, LlmScript } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-19: a model per AI task, against the LLM stub, on a Studio of its own (port 4409).
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const S3 = "slides/03_point.slide.md";

let stub: LlmStub;
let workspace: string;
let configDir: string;
let library: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
/** The model of every chat request the stub answered or refused, in order. */
let asked: string[];

/** "big" answers chat in text; the other models answer rewrites in JSON; `gone` models are 404. */
const script = (models: string[]): LlmScript => ({
  models,
  chat: (request): LlmFixture => {
    asked.push(request.model);
    if (!models.includes(request.model)) return { kind: "status", status: 404 };
    return request.model === "big"
      ? { kind: "text", text: "The deck asks for one decision." }
      : { kind: "json", value: { markdown: "# Shorter point\n\nOne line." } };
  },
});

async function boot(taskModels: Record<string, string> | null) {
  asked = [];
  stub = await startLlmStub({ script: script(["small", "big", "huge"]) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-task-models-"));
  workspace = path.join(root, "ws");
  library = path.join(root, "library");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), path.join(workspace, "talk"), { recursive: true });
  configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  const llm = {
    baseUrl: stub.url,
    model: "small",
    apiKey: null,
    temperature: 0.2,
    timeoutMs: 5_000,
    maxRepairRounds: 0,
    ...(taskModels ? { taskModels } : {}),
  };
  await fs.writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({ version: 1, llm, lastWorkspace: null }),
    {
      mode: 0o600,
    },
  );
  studio = await startStudio(workspace, configDir, 4409, library);
}
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

const savedLlm = async () => JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8")).llm;
const taskSelect = (page: Page, label: string) => page.getByLabel(`Model for ${label}`);
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
}
const rewriteAction = (page: Page) =>
  page.getByTestId("ai-action").filter({ has: page.getByRole("button", { name: "AI", exact: true }) });
const chatPanel = (page: Page) => page.getByRole("complementary", { name: "Deck chat" });
async function openSlide(page: Page) {
  await page.goto(`${studio.url}decks/${id("talk")}/slides/${encodeURIComponent(S3)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
async function ask(page: Page, message: string) {
  const panel = chatPanel(page);
  if (!(await panel.getByLabel("Message").isVisible()))
    await panel.getByRole("button", { name: "Chat" }).click();
  await panel.getByLabel("Message").fill(message);
  await panel.getByRole("button", { name: "Send" }).click();
}
async function shorten(page: Page) {
  await rewriteAction(page).getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "Shorten" }).click();
  await expect(page.getByTestId("op-card")).toBeVisible();
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(0);
}

test("Settings sets, keeps and clears a task's model, and marks one the server lost", async ({ page }) => {
  await boot({ chat: "gone" });
  await page.goto(`${studio.url}settings`);
  const chat = taskSelect(page, "Chat");
  await expect(chat).toHaveValue("gone");
  await expect(page.getByTestId("task-model-missing-chat")).toContainText("gone isn't on this server");
  await expect(taskSelect(page, "Rewrite a slide")).toHaveValue("");
  await expect(taskSelect(page, "Rewrite a slide").locator("option").first()).toHaveText(
    "Same as default (small)",
  );

  await chat.selectOption("big");
  await save(page);
  expect((await savedLlm()).taskModels).toEqual({ chat: "big" });
  await page.reload();
  await expect(taskSelect(page, "Chat")).toHaveValue("big");
  await expect(page.getByTestId("task-model-missing-chat")).toHaveCount(0);

  await stopStudio(studio.child);
  studio = await startStudio(workspace, configDir, 4409, library);
  await page.goto(`${studio.url}settings`);
  await expect(taskSelect(page, "Chat")).toHaveValue("big");

  await taskSelect(page, "Chat").selectOption("");
  await save(page);
  const llm = await savedLlm();
  expect("taskModels" in llm).toBe(false);
  expect(llm.model).toBe("small");
});

test("each task runs on its model, the default moves only the rest, and a lost model fails only its task", async ({
  page,
}) => {
  await boot({ chat: "big" });
  await openSlide(page);
  await expect(rewriteAction(page).getByTestId("ai-model")).toHaveText("small");
  await expect(chatPanel(page).getByTestId("ai-model")).toHaveText("big");

  await ask(page, "What does the deck ask for?");
  await expect(chatPanel(page).getByTestId("chat-assistant")).toContainText("one decision");
  await expect(chatPanel(page).getByTestId("chat-model")).toHaveText("big");
  expect(asked.at(-1)).toBe("big");

  await shorten(page);
  expect(asked.at(-1)).toBe("small");

  // A new default moves the tasks on "Same as default" only.
  await page.goto(`${studio.url}settings`);
  await page.getByLabel("Model", { exact: true }).selectOption("huge");
  await save(page);
  await page.goto(studio.url);
  await page.getByRole("button", { name: "New deck" }).first().click();
  await expect(page.getByRole("dialog", { name: "New deck" }).getByTestId("ai-model")).toHaveText("huge");
  await page.goto(`${studio.url}kits/themes`);
  await expect(page.getByTestId("ai-model")).toHaveText("huge");
  await openSlide(page);
  await expect(rewriteAction(page).getByTestId("ai-model")).toHaveText("huge");
  await expect(chatPanel(page).getByTestId("ai-model")).toHaveText("big");
  await shorten(page);
  expect(asked.at(-1)).toBe("huge");

  // The server loses "big": chat fails in its panel, naming it; rewriting still works.
  stub.setScript(script(["small", "huge"]));
  await ask(page, "And now?");
  const error = chatPanel(page).getByRole("alert");
  await expect(error).toContainText("Chat is set to use big");
  await expect(error).toContainText("Model for each task");
  await shorten(page);
  expect(asked.at(-1)).toBe("huge");
});
