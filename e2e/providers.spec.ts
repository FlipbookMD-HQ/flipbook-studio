import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startAnthropicStub, type AnthropicStub } from "../test/support/anthropic-stub";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-21: Settings → Providers against a fake Anthropic server, on a Studio of its own (port 4410).
const FIRST_KEY = "sk-ant-api03-e2e-first-key-a1b2";
const SECOND_KEY = "sk-ant-api03-e2e-second-key-c3d4";

let local: LlmStub;
let anthropic: AnthropicStub;
let workspace: string;
let configDir: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

const LOCAL_LLM = (baseUrl: string) => ({
  baseUrl,
  model: "small",
  apiKey: null,
  temperature: 0.2,
  timeoutMs: 5_000,
  maxRepairRounds: 0,
  taskModels: { chat: "big" },
});

test.beforeEach(async () => {
  local = await startLlmStub({ script: { models: ["small", "big"] } });
  anthropic = await startAnthropicStub({ apiKey: FIRST_KEY });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-providers-"));
  workspace = path.join(root, "ws");
  configDir = path.join(root, "config");
  await fs.cp(path.resolve("fixtures/ws/blueprint-talk"), path.join(workspace, "talk"), { recursive: true });
  await fs.mkdir(configDir, { mode: 0o700 });
  await fs.writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({ version: 1, llm: LOCAL_LLM(local.url), lastWorkspace: null }),
    { mode: 0o600 },
  );
  studio = await startStudio(workspace, configDir, 4410, undefined, {
    FLIPBOOK_STUDIO_ANTHROPIC_URL: anthropic.url,
  });
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await anthropic.close();
  await local.close();
});

const saved = async () => JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
const card = (page: Page) => page.getByTestId("provider-anthropic");

test("add Anthropic, list and test its models, replace the key and remove it; no task model changes", async ({
  page,
}) => {
  await page.goto(`${studio.url}settings`);
  await expect(page.getByTestId("no-providers")).toBeVisible();
  await expect(page.getByLabel("Model for Chat")).toHaveValue("big");

  // Add: choose the kind, type the key.
  await page.getByRole("button", { name: "Add a provider" }).click();
  const form = page.getByRole("form", { name: "Add a provider" });
  await form.getByLabel("Anthropic (Claude)").check();
  await expect(form.getByLabel("Base URL")).toHaveCount(0);
  await form.getByLabel("API key", { exact: true }).fill(FIRST_KEY);
  await form.getByRole("button", { name: "Add", exact: true }).click();

  // The card shows only the hint, and lists the chat models at once.
  await expect(card(page).getByTestId("key-hint")).toHaveText("Key sk-…a1b2");
  await expect(card(page).getByTestId("model-count")).toHaveText("3 chat models");
  const models = card(page).getByLabel("Model of Anthropic");
  await expect(models.locator("option")).toHaveText([
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ]);
  const file = await saved();
  expect(file.providers).toEqual([
    { id: "anthropic", kind: "anthropic", label: "Anthropic", baseUrl: anthropic.url, apiKey: FIRST_KEY },
  ]);
  expect(file.llm).toEqual(LOCAL_LLM(local.url));
  expect(await page.content()).not.toContain(FIRST_KEY);

  // A second Anthropic provider can't be added.
  await page.getByRole("button", { name: "Add a provider" }).click();
  await expect(form.getByLabel("Anthropic (Claude)")).toBeDisabled();
  await form.getByRole("button", { name: "Cancel" }).click();

  // Test: the reply, its latency and its tokens.
  await models.selectOption("claude-haiku-4-5");
  await card(page).getByRole("button", { name: "Test" }).click();
  await expect(card(page).getByTestId("provider-test-result")).toContainText(
    /“Ready\.” in \d+ ms · 18 in \/ 3 out tokens/,
  );
  expect(anthropic.requests.at(-1)!.body).toMatchObject({ model: "claude-haiku-4-5" });
  expect(anthropic.requests.at(-1)!.headers["x-api-key"]).toBe(FIRST_KEY);

  // The account's key changes: the error shows the masked key, then Replace key fixes it.
  anthropic.setScript({ apiKey: SECOND_KEY });
  await card(page).getByRole("button", { name: "Test" }).click();
  const error = card(page).getByTestId("provider-test-error");
  await expect(error).toContainText("rejected the API key sk-…a1b2");
  await expect(error).toContainText("Replace key");
  expect(await page.content()).not.toContain(FIRST_KEY);

  await card(page).getByRole("button", { name: "Replace key" }).click();
  const newKey = card(page).getByLabel("New API key");
  await expect(newKey).toHaveValue("");
  await newKey.fill(SECOND_KEY);
  await card(page).getByRole("button", { name: "Save key" }).click();
  await expect(card(page).getByTestId("key-hint")).toHaveText("Key sk-…c3d4");
  await expect(card(page).getByTestId("model-count")).toHaveText("3 chat models");
  await models.selectOption("claude-sonnet-4-5");
  await card(page).getByRole("button", { name: "Test" }).click();
  await expect(card(page).getByTestId("provider-test-result")).toContainText("“Ready.”");
  expect((await saved()).providers[0].apiKey).toBe(SECOND_KEY);

  // Reloaded: still only the hint, and no key field filled in.
  await page.reload();
  await expect(card(page).getByTestId("key-hint")).toHaveText("Key sk-…c3d4");
  await expect(card(page).locator('input[type="password"]')).toHaveCount(0);
  expect(await page.content()).not.toContain(SECOND_KEY);

  // Remove, with a confirmation.
  await card(page).getByRole("button", { name: "Remove", exact: true }).click();
  await card(page)
    .getByRole("group", { name: "Remove Anthropic" })
    .getByRole("button", { name: "Keep it" })
    .click();
  await expect(card(page)).toBeVisible();
  await card(page).getByRole("button", { name: "Remove", exact: true }).click();
  await card(page).getByRole("button", { name: "Remove provider" }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("no-providers")).toBeVisible();

  // No task model changed, and the local model is untouched.
  const after = await saved();
  expect(after).toEqual({ version: 1, llm: LOCAL_LLM(local.url), lastWorkspace: null });
  await expect(page.getByLabel("Model for Chat")).toHaveValue("big");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("small");
  // Nothing was ever sent to the provider but the key checks above: no deck content.
  for (const request of anthropic.requests)
    expect(JSON.stringify(request.body ?? {})).not.toMatch(/blueprint-talk|slide/i);
});

test("the local model list hides models that can't chat, and marks a saved one", async ({ page }) => {
  local.setScript({ models: ["small", "big", "nomic-embed-text"] });
  await fs.writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      version: 1,
      llm: { ...LOCAL_LLM(local.url), taskModels: { chat: "nomic-embed-text" } },
      lastWorkspace: null,
    }),
    { mode: 0o600 },
  );
  await stopStudio(studio.child);
  studio = await startStudio(workspace, configDir, 4410, undefined, {
    FLIPBOOK_STUDIO_ANTHROPIC_URL: anthropic.url,
  });
  await page.goto(`${studio.url}settings`);
  await expect(page.getByTestId("task-model-missing-chat")).toHaveText(
    "nomic-embed-text is not a chat model. Pick another model.",
  );
  await expect(page.getByLabel("Model", { exact: true }).locator("option")).toHaveText(["small", "big"]);
});
