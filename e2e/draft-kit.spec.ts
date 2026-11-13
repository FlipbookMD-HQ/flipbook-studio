import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { startStudio, stopStudio } from "./support/studio";

// US-14: draft kit pieces with the LLM stub, on a Studio and library of its own (port 4403).
const CSS = `:host {
  --slide-bg: #2b1d14;
  --slide-text: #f6eadf;
  --slide-muted: #c9b29d;
  --slide-accent: #e07a4f;
  --slide-mint: #f2c57c;
  --slide-heading: #fff7ef;
  --slide-line: #5a3d2b;
  --slide-code: #1f150e;
  font-family: Georgia, serif;
}`;
const GROUP = {
  description: "Warm quarterly reports.",
  canvas: "midnight",
  themes: [{ name: "report-sand", draft: "Warm sand, terracotta accents" }],
  style: "report-sand",
  templates: {
    cover: { column: 1, row: 1, width: 3, height: 3, align: "center", role: "cover", layout: "poster" },
    body: { column: 1, row: 1, width: 3, height: 3, align: "start", role: "content" },
  },
  blueprint: {
    types: { cover: { template: "cover", require: ["heading"] }, point: { template: "body", max_items: 4 } },
    pages: [{ type: "cover" }, { type: "point", repeat: { min: 1, max: 6 } }],
  },
};

let stub: LlmStub;
let root: string;
let library: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
let replies: LlmFixture[];
let calls: number;

async function listAll(dir: string): Promise<string[]> {
  return ((await fs.readdir(dir, { recursive: true }).catch(() => [])) as string[]).map(String).sort();
}

test.beforeEach(async () => {
  calls = 0;
  replies = [];
  stub = await startLlmStub({
    script: {
      models: ["stub-model"],
      chat: () => replies[Math.min(calls++, replies.length - 1)]!,
    },
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-draft-kit-"));
  const workspace = path.join(root, "ws");
  library = path.join(root, "library");
  await fs.mkdir(workspace);
  await fs.mkdir(library);
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
    { mode: 0o600 },
  );
  studio = await startStudio(workspace, configDir, 4403, library);
});
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

test("a drafted theme opens unsaved with a preview; saving writes the file", async ({ page }) => {
  replies = [{ kind: "json", value: { css: CSS } }];
  await page.goto(`${studio.url}kits/themes`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Draft a theme with AI" });
  await dialog.getByLabel("Name").fill("sand");
  await dialog.getByLabel("Description").fill("Warm sand and terracotta");
  await dialog.getByRole("button", { name: "Draft", exact: true }).click();

  await expect(page).toHaveURL(/\/kits\/themes\/new$/);
  await expect(page.getByText("Unsaved draft")).toBeVisible();
  await expect(page.getByLabel("Name of the library theme")).toHaveValue("sand");
  await expect(page.getByTestId("theme-preview")).toBeVisible();
  await expect(page.getByLabel("--slide-accent color")).toHaveValue("#e07a4f");
  expect(await listAll(library)).not.toContain("themes/sand.css");

  // Leaving asks first.
  await page.getByRole("link", { name: "Themes" }).first().click();
  await expect(page.getByRole("heading", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Stay" }).click();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/kits\/themes\/library\/sand$/);
  expect(await fs.readFile(path.join(library, "themes/sand.css"), "utf8")).toBe(`${CSS}\n`);
});

test("a drafted media kit with a new theme gives two files; Accept all writes both and the kit makes decks", async ({
  page,
}) => {
  replies = [
    { kind: "json", value: GROUP },
    { kind: "json", value: { css: CSS } },
  ];
  await page.goto(`${studio.url}kits/media`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Draft a media kit with AI" });
  await dialog.getByLabel("Name").fill("report");
  await dialog.getByLabel("Description").fill("Quarterly reports in warm colours");
  await dialog.getByRole("button", { name: "Draft", exact: true }).click();

  await expect(dialog.getByTestId("op-card")).toHaveCount(2);
  await expect(dialog.getByTestId("op-card").first()).toContainText("Writes the group report (library)");
  await expect(dialog.getByTestId("op-card").last()).toContainText("Writes the theme report-sand (library)");
  expect(await listAll(library)).toEqual([]);
  await dialog.getByRole("button", { name: "Accept all" }).click();

  await expect(page).toHaveURL(/\/kits\/media\/library\/report$/);
  expect(await fs.readFile(path.join(library, "themes/report-sand.css"), "utf8")).toBe(`${CSS}\n`);
  expect(await fs.readFile(path.join(library, "templates/report.yml"), "utf8")).toContain("report_cover:");

  await page.goto(studio.url);
  await page.getByRole("button", { name: "New deck" }).first().click();
  const newDeck = page.getByRole("dialog", { name: "New deck" });
  await newDeck.getByLabel("Title").fill("Q3 review");
  await newDeck.getByRole("radio", { name: /report/ }).check();
  await newDeck.getByRole("button", { name: "Create deck" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Q3 review");
  await expect(page.getByTestId("slide-thumb")).toHaveCount(2);
});

test("invalid output shows the parse error and Retry, and the disk is unchanged", async ({ page }) => {
  replies = [
    { kind: "json", value: { css: ":host { --slide-bg: #000;" } },
    { kind: "json", value: { css: ":host { --slide-bg: #000;" } },
    { kind: "json", value: { css: CSS } },
  ];
  const before = await listAll(root);
  await page.goto(`${studio.url}kits/themes`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Draft a theme with AI" });
  await dialog.getByLabel("Name").fill("broken");
  await dialog.getByLabel("Description").fill("Anything");
  await dialog.getByRole("button", { name: "Draft", exact: true }).click();

  await expect(dialog.getByTestId("draft-failed")).toContainText("doesn't parse: A { is not closed");
  await expect(dialog.getByTestId("draft-failed")).toContainText("Nothing was written.");
  expect(await listAll(root)).toEqual(before);

  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(/\/kits\/themes\/new$/);
  await expect(page.getByText("Unsaved draft")).toBeVisible();
  expect(await listAll(root)).toEqual(before);
});

test("template and blueprint drafts open in their editors, unsaved", async ({ page }) => {
  replies = [
    { kind: "json", value: { column: 1, row: 2, width: 3, height: 2, align: "center", role: "quote" } },
    {
      kind: "json",
      value: { ...GROUP.blueprint, types: { cover: { template: "cover" }, point: { template: "flow" } } },
    },
  ];
  await page.goto(`${studio.url}kits/templates`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  let dialog = page.getByRole("dialog", { name: "Draft a template with AI" });
  await dialog.getByLabel("Name").fill("lower-band");
  await dialog.getByLabel("Description").fill("A band over the lower two thirds");
  await dialog.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(page).toHaveURL(/\/kits\/templates\/new$/);
  await expect(page.getByText("Unsaved draft")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("lower-band");
  await expect(page.getByRole("spinbutton", { name: "Row" })).toHaveValue("2");
  await expect(page.getByTestId("template-preview")).toBeVisible();

  // A blueprint draft opens in the blueprint editor the same way.
  await page.goto(`${studio.url}kits/blueprints`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  dialog = page.getByRole("dialog", { name: "Draft a blueprint with AI" });
  await dialog.getByLabel("Name").fill("report");
  await dialog.getByLabel("Description").fill("A cover then points");
  await dialog.getByRole("button", { name: "Draft", exact: true }).click();
  await expect(page).toHaveURL(/\/kits\/blueprints\/new$/);
  await expect(page.getByLabel("Blueprint name")).toHaveValue("report");
  expect(await listAll(library)).toEqual([]);
});
