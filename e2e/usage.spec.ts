import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-25: tokens per paid run and per session, against the fake OpenAI server, on a Studio of its
// own (port 4414). Rewrite runs on OpenAI; chat stays local.
const KEY = "sk-proj-e2e-usage-openai-e5f6";
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const SHORT = JSON.stringify({ markdown: "# System Design\n\nDesign services that scale." });

let local: LlmStub;
let openai: LlmStub;
let studio: Awaited<ReturnType<typeof startStudio>>;
/** What fake OpenAI answers next. */
let reply: LlmFixture;

test.beforeEach(async () => {
  reply = { kind: "text", text: SHORT, usage: { prompt: 1_234, completion: 56 } };
  local = await startLlmStub({
    script: {
      models: ["small"],
      chat: () => ({ kind: "text", text: "It has five slides.", usage: { prompt: 9, completion: 4 } }),
    },
  });
  openai = await startLlmStub({ script: { apiKey: KEY, models: ["gpt-4o"], chat: () => reply } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-usage-"));
  const workspace = path.join(root, "ws");
  await fs.mkdir(workspace);
  await fs.cp("fixtures/ws/system-design.slide.md", path.join(workspace, "system-design.slide.md"));
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  const settings = {
    version: 1,
    llm: {
      baseUrl: local.url,
      model: "small",
      apiKey: null,
      temperature: 0.2,
      timeoutMs: 10_000,
      maxRepairRounds: 1,
      taskModels: { rewrite: { provider: "openai", model: "gpt-4o" } },
    },
    providers: [{ id: "openai", kind: "openai", label: "OpenAI", baseUrl: openai.url, apiKey: KEY }],
    lastWorkspace: null,
  };
  await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  studio = await startStudio(workspace, configDir, 4414, undefined, {
    FLIPBOOK_STUDIO_OPENAI_URL: openai.url,
  });
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await openai.close();
  await local.close();
});

async function rewrite(page: Page) {
  const action = page
    .getByTestId("ai-action")
    .filter({ has: page.getByRole("button", { name: "AI", exact: true }) });
  await action.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "Shorten" }).click();
}

test("a rewrite on OpenAI shows its tokens, and Settings shows the session total; local runs show none", async ({
  page,
}) => {
  // A new Studio has no totals yet.
  await page.goto(`${studio.url}settings`);
  const session = page.getByTestId("session-usage");
  await expect(session.getByTestId("no-usage")).toHaveText("No paid requests since Studio started.");

  // The rewrite's panel shows the tokens fake OpenAI reported.
  await page.goto(`${studio.url}decks/${id("system-design.slide.md")}/slides/${encodeURIComponent("#0")}`);
  await rewrite(page);
  await expect(page.getByTestId("op-card")).toBeVisible();
  await expect(page.getByTestId("ai-usage")).toHaveText("1,234 in · 56 out tokens");
  await page.getByRole("button", { name: "Reject all" }).click();
  // The count stays until the next run.
  await expect(page.getByTestId("ai-usage")).toHaveText("1,234 in · 56 out tokens");

  // A provider that sends no usage: "usage not reported", not an estimate.
  reply = { kind: "text", text: SHORT };
  await rewrite(page);
  await expect(page.getByTestId("op-card")).toBeVisible();
  await expect(page.getByTestId("ai-usage")).toHaveText("usage not reported");
  await page.getByRole("button", { name: "Reject all" }).click();

  // A local chat shows no token count.
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByLabel("Message").fill("How many slides?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("chat-assistant")).toContainText("It has five slides.");
  await expect(page.getByTestId("chat-model")).toHaveText("small");
  await expect(page.getByTestId("chat-assistant").getByTestId("ai-usage")).toHaveCount(0);

  // Settings → Providers: the updated session total for OpenAI, tokens only.
  await page.goto(`${studio.url}settings`);
  const total = page.getByTestId("usage-openai");
  await expect(total).toContainText("OpenAI");
  await expect(total.getByTestId("usage-tokens")).toHaveText("1,234 in · 56 out tokens");
  await expect(total).toContainText("2 requests");
  await expect(total).toContainText("1 with usage not reported");
  await expect(page.getByTestId("usage-local")).toHaveCount(0);
  await expect(page.getByTestId("providers")).not.toContainText(/\$|price|cost|estimat/i);
});
