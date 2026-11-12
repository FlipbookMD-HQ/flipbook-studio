import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";

const deckId = Buffer.from("system-design.slide.md", "utf8").toString("base64url");

/** A Studio of its own, so the test can restart it with the same settings folder. */
async function startStudio(
  workspace: string,
  configDir: string,
): Promise<{ url: string; banner: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    ["bin/flipbook-studio.js", workspace, "--no-open", "--port", "4400"],
    {
      env: {
        ...process.env,
        FLIPBOOK_HOME: path.resolve("fixtures/library"),
        FLIPBOOK_STUDIO_CONFIG_DIR: configDir,
      },
    },
  );
  let out = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      out += String(chunk);
      const match = /URL: +(http:\/\/\S+)/.exec(out);
      if (match && /LLM:.*\n/.test(out)) resolve(match[1]!);
    });
    child.on("exit", (code) => reject(new Error(`Studio exited ${code}: ${out}`)));
  });
  return { url, banner: out, child };
}
const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });

let stub: LlmStub;
let workspace: string;
let configDir: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

test.beforeEach(async () => {
  stub = await startLlmStub({
    script: { models: ["qwen2.5:0.5b", "llama3.2:1b"], chat: [{ kind: "text", text: "Ready." }] },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-settings-"));
  workspace = path.join(root, "ws");
  configDir = path.join(root, "config");
  await fs.cp("fixtures/ws", workspace, { recursive: true });
  studio = await startStudio(workspace, configDir);
});
test.afterEach(async () => {
  await stop(studio.child);
  await stub.close();
});

const aiButton = (page: Page) => page.getByTestId("ai-action").getByRole("button", { name: /Ask AI/ });

test("connect a model: list, test, save; AI buttons enable; settings survive a restart", async ({ page }) => {
  await page.goto(`${studio.url}decks/${deckId}`);
  await expect(aiButton(page)).toBeDisabled();
  await page.getByRole("link", { name: "Set up a local model" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  // The Ollama preset is the default; point it at the stub (a custom URL on another port).
  await page.getByLabel("Ollama").check();
  await expect(page.getByLabel("Base URL")).toHaveValue("http://127.0.0.1:11434/v1");
  await page.getByLabel("Base URL").fill(stub.url);
  await expect(page.getByLabel("Custom")).toBeChecked();
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("qwen2.5:0.5b");
  await page.getByLabel("Model", { exact: true }).selectOption("llama3.2:1b");
  await expect(page.getByTestId("remote-notice")).toHaveCount(0);

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByTestId("test-result")).toContainText(/“Ready\.” in \d+ ms/);
  expect(stub.requests.at(-1)!.body).toMatchObject({ model: "llama3.2:1b" });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved. AI features use llama3.2:1b.");
  await page.goto(`${studio.url}decks/${deckId}`);
  await expect(aiButton(page)).toBeEnabled();
  await expect(page.getByRole("link", { name: "Set up a local model" })).toHaveCount(0);
  await aiButton(page).click();
  await expect(page.getByTestId("ai-note")).toBeVisible();

  // Restart Studio with the same settings folder.
  await stop(studio.child);
  studio = await startStudio(workspace, configDir);
  expect(studio.banner).toContain(`LLM:       llama3.2:1b @ ${stub.url}`);
  await page.goto(`${studio.url}settings`);
  await expect(page.getByLabel("Base URL")).toHaveValue(stub.url);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("llama3.2:1b");
  const file = JSON.parse(await fs.readFile(path.join(configDir, "settings.json"), "utf8"));
  expect(file.llm).toMatchObject({ baseUrl: stub.url, model: "llama3.2:1b" });
  // Stored outside every deck.
  expect(path.relative(workspace, configDir).startsWith("..")).toBe(true);
});

test("a 401 shows the error, an empty list says how to pull a model, a remote URL shows the notice", async ({
  page,
}) => {
  await page.goto(`${studio.url}settings`);
  stub.setScript({ apiKey: "sk-right" });
  await page.getByLabel("Base URL").fill(stub.url);
  await page.getByLabel("API key (optional)").fill("sk-wrong");
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(page.getByTestId("models-error")).toContainText(`${stub.url} rejected the API key.`);
  await expect(page.getByTestId("models-error")).toContainText("Check the API key.");

  stub.setScript({ models: [] });
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(page.getByTestId("no-models")).toHaveText("No models — ollama pull <model>");
  await expect(page.getByTestId("save-reason")).toHaveText("Pick a model.");

  await page.getByLabel("Base URL").fill("http://192.168.1.50:11434/v1");
  await expect(page.getByTestId("remote-notice")).toHaveText("Deck content will be sent to 192.168.1.50.");
});
