import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-13: generate a deck with the LLM stub, on a Studio of its own (port 4402).
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const COVER = {
  type: "cover",
  markdown: "# Marvel reading guide\n\n![Iron Man](image.png)\n\nWhere to start.",
};
const timeline = (title: string, items: string[]) => ({
  type: "timeline",
  markdown: `# ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}`,
});
const lines = (...slides: object[]): LlmFixture => ({
  kind: "text",
  text: `${slides.map((slide) => JSON.stringify(slide)).join("\n")}\n`,
});

type Request = { messages: { role: string; content: string }[] };
let stub: LlmStub;
let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
let reply: (request: Request) => LlmFixture;
let prompts: string[];

/** `flipbook check`'s errors: FLIPBOOK_CLI, else a sibling flipbook-md checkout, else null. */
function flipbookCheck(target: string): string[] | null {
  const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
  const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
  if (!cli) return null;
  const run = spawnSync(process.execPath, [cli, "check", target], {
    encoding: "utf8",
    env: { ...process.env, FLIPBOOK_HOME: path.resolve("fixtures/library") },
  });
  return run.status === 0 ? [] : run.stderr.trim().split("\n").filter(Boolean);
}

test.beforeEach(async () => {
  prompts = [];
  reply = () =>
    lines(COVER, timeline("Phase One", ["Iron Man", "Thor"]), timeline("Phase Two", ["Avengers"]));
  stub = await startLlmStub({
    script: {
      models: ["stub-model"],
      chat: (request) => {
        prompts.push(request.messages.at(-1)!.content);
        return reply(request);
      },
    },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-generate-"));
  workspace = path.join(root, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "existing.slide.md"), "# Hello\n");
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
  studio = await startStudio(workspace, configDir, 4402);
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

async function fill(page: Page, title: string, source: { topic: string } | { text: string }) {
  await page.goto(studio.url);
  await page.getByRole("button", { name: "New deck" }).first().click();
  await page.getByRole("button", { name: "Generate with AI" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("marvel_content_guide").check();
  if ("topic" in source) await page.getByLabel("Topic", { exact: true }).fill(source.topic);
  else {
    await page.getByLabel("Paste text").check();
    await page.getByLabel("Source text").fill(source.text);
  }
}

test("a topic and a kit give a deck that follows the blueprint and passes flipbook check", async ({
  page,
}) => {
  await fill(page, "Marvel guide", { topic: "Watching the Marvel films in order" });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("marvel-guide")}/slides/`));
  await expect(page.getByRole("link", { name: /Marvel reading guide/ }).first()).toBeVisible();
  expect(prompts[0]).toContain('1. type "cover": exactly 1 slide');
  expect(prompts[0]).toContain("<topic>\nWatching the Marvel films in order\n</topic>");
  const errors = flipbookCheck(path.join(workspace, "marvel-guide"));
  if (errors) expect(errors).toEqual([]);
  await expect(page.getByText("Matches the blueprint.")).toBeVisible();
});

test("pasted Portuguese text gives Portuguese slides", async ({ page }) => {
  const text = "A Fase Um começa com Homem de Ferro. Depois vem Thor. A Fase Dois começa com Os Vingadores.";
  reply = () =>
    lines(
      { type: "cover", markdown: "# Guia de leitura\n\n![Homem de Ferro](image.png)\n\nPor onde começar." },
      timeline("Fase Um", ["Homem de Ferro", "Thor"]),
      timeline("Fase Dois", ["Os Vingadores"]),
    );
  await fill(page, "Guia", { text });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("guia")}/slides/`));
  expect(prompts[0]).toContain(`<source_text>\n${text}\n</source_text>`);
  expect(prompts[0]).toContain("Keep its facts, its order and its language");
  expect(prompts[0]).toContain("Write in the same language as the source text.");
  const slides = await fs.readdir(path.join(workspace, "guia", "slides"));
  const all = (
    await Promise.all(slides.map((file) => fs.readFile(path.join(workspace, "guia", "slides", file), "utf8")))
  ).join("\n");
  expect(all).toContain("# Fase Um");
  expect(all).toContain("Os Vingadores");
});

test("cancelling mid-generation leaves no deck", async ({ page }) => {
  reply = () => ({
    kind: "slowTokens",
    ms: 120,
    text: `${JSON.stringify(COVER)}\n${JSON.stringify(timeline("Phase One", ["Iron Man", "Thor", "Hulk"]))}\n`,
  });
  const before = (await fs.readdir(workspace)).sort();
  await fill(page, "Cancelled", { topic: "Anything" });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("generated-slide")).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog", { name: "Stop generating?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop and discard" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await fs.readdir(workspace)).sort()).toEqual(before);
});

test("when repairs run out, the deck is saved and opens at the failing slide", async ({ page }) => {
  const long = timeline("Phase One", ["A", "B", "C", "D", "E", "F", "G"]);
  reply = (request) =>
    request.messages.at(-1)!.content.includes("breaks the deck's rules")
      ? { kind: "json", value: long }
      : lines(COVER, long);
  await fill(page, "Too long", { topic: "Everything" });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/decks/${id("too-long")}/slides/${encodeURIComponent("slides/03_timeline.slide.md")}`),
  );
  await expect(page.getByTestId("check-panel")).toContainText("maximum is 5");
});
