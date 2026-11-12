import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-12: rewrite a slide with AI against the LLM stub, on a Studio of its own (port 4401).
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const SHORT = "# System Design\n\nDesign services that scale.";
const PITCH = {
  "pitch/presentation.yml": "title: Pitch\nslides:\n  - slides/01_cover.slide.md\n",
  "pitch/blueprint.yml": "pages:\n  - type: cover\ntypes:\n  cover:\n    max_chars: 40\n",
  "pitch/slides/01_cover.slide.md": "# Cover\n\nWe save time.\n",
};

let stub: LlmStub;
let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
let reply: (request: { messages: { content: string }[] }) => LlmFixture;

test.beforeEach(async () => {
  reply = () => ({ kind: "json", value: { markdown: SHORT } });
  stub = await startLlmStub({ script: { models: ["stub-model"], chat: (request) => reply(request) } });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-rewrite-"));
  workspace = path.join(root, "ws");
  await fs.cp("fixtures/ws/system-design.slide.md", path.join(workspace, "system-design.slide.md"));
  for (const [name, body] of Object.entries(PITCH)) {
    await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.writeFile(path.join(workspace, name), body);
  }
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
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
  studio = await startStudio(workspace, configDir, 4401);
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

const single = () => path.join(workspace, "system-design.slide.md");
const read = (file: string) => fs.readFile(file, "utf8");
async function rewrite(page: Page, deck: string, slide: string, kind = "Shorten") {
  await page.goto(`${studio.url}decks/${id(deck)}/slides/${encodeURIComponent(slide)}`);
  await page.getByTestId("ai-action").getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: kind }).click();
}

test("shorten → diff → accept changes only the body; reject leaves the file alone", async ({ page }) => {
  const before = await read(single());
  await rewrite(page, "system-design.slide.md", "#0");
  const card = page.getByTestId("op-card");
  await expect(card.getByTestId("diff")).toContainText("Design services that scale.");
  expect(await read(single())).toBe(before); // Nothing is written before accepting.

  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(0);
  expect(await read(single())).toBe(before);

  await rewrite(page, "system-design.slide.md", "#0");
  await page.getByTestId("op-card").getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("op-card")).toHaveAttribute("data-state", "applied");
  const after = await read(single());
  expect(after).toContain("Design services that scale.");
  expect(after).not.toContain("A practical framework");
  // The directive and every other slide are untouched.
  expect(after).toContain("<!-- eyebrow: ARCHITECTURE -->");
  expect(after.slice(after.indexOf("# Start with requirements"))).toBe(
    before.slice(before.indexOf("# Start with requirements")),
  );
  // The editor reloads the saved slide.
  await expect(page.getByLabel("Markdown", { exact: true })).toContainText("Design services that scale.");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
});

test("a proposal that breaks the blueprint shows the violation, and Retry gives a new one", async ({
  page,
}) => {
  reply = (request) =>
    request.messages.at(-1)!.content.includes("previous attempt broke")
      ? { kind: "json", value: { markdown: "# Cover\n\nFaster." } }
      : {
          kind: "json",
          value: { markdown: "# Cover\n\nWe save you time, money and a great deal of effort." },
        };
  await rewrite(page, "pitch", "slides/01_cover.slide.md", "Expand");
  await expect(page.getByTestId("op-violations")).toContainText("maximum is 40");
  await page.getByTestId("op-violations").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("diff")).toContainText("Faster.");
  await expect(page.getByTestId("op-violations")).toHaveCount(0);
});

test("a model that hangs shows the timeout and leaves the slide unchanged", async ({ page }) => {
  reply = () => ({ kind: "hang" });
  const before = await read(single());
  await rewrite(page, "system-design.slide.md", "#0");
  await expect(page.getByTestId("ai-tokens")).toBeVisible();
  await expect(page.getByTestId("ai-error")).toContainText("stopped responding", { timeout: 15_000 });
  await expect(page.getByTestId("ai-error")).toContainText("The slide was not changed.");
  await expect(page.getByTestId("ai-error").getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await read(single())).toBe(before);
  // Manual editing still works.
  await expect(page.getByLabel("Speaker notes")).toBeEditable();
});

test("editing the file on disk before accepting marks the op stale", async ({ page }) => {
  await rewrite(page, "system-design.slide.md", "#0");
  await expect(page.getByTestId("diff")).toBeVisible();
  const edited = (await read(single())).replace("A practical framework", "An edited framework");
  await fs.writeFile(single(), edited);
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByTestId("op-card")).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("op-card")).toContainText("Stale — changed on disk");
  expect(await read(single())).toBe(edited);
});
