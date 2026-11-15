import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LlmFixture } from "../test/support/llm-fixtures";
import { startLlmStub, type LlmStub } from "../test/support/llm-stub";
import { PNG, buildDocx, docx } from "../test/support/docx";
import { startStudio, stopStudio } from "./support/studio";

// US-18: start a deck from an uploaded file, on a Studio of its own (port 4407).
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const GUIDE = buildDocx({
  body: [
    docx.heading(1, "Indexes"),
    docx.para("Why they matter."),
    docx.heading(2, "Kinds"),
    docx.bullet("B-tree"),
    docx.image("rIdImg", "a chart"),
    docx.heading(2, "Costs"),
    docx.para("Writes get slower."),
    docx.image("rIdEmf", "vector"),
  ].join(""),
  images: [
    { rel: "rIdImg", file: "chart.png", data: PNG },
    { rel: "rIdEmf", file: "v.emf", data: Buffer.from("EMF") },
  ],
});

/** `flipbook check`'s exit status and errors: FLIPBOOK_CLI, else a sibling flipbook-md checkout, else null. */
function flipbookCheck(target: string) {
  const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
  const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
  if (!cli) return null;
  return spawnSync(process.execPath, [cli, "check", target], {
    encoding: "utf8",
    env: { ...process.env, FLIPBOOK_HOME: path.resolve("fixtures/library") },
  });
}

let stub: LlmStub;
let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;
let prompts: string[];

async function start(withModel: boolean) {
  prompts = [];
  stub = await startLlmStub({
    script: {
      models: ["stub-model"],
      chat: (request): LlmFixture => {
        prompts.push(request.messages.at(-1)!.content);
        return {
          kind: "text",
          text: [
            { type: null, markdown: "# Índices\n\nPor que importam." },
            { type: null, markdown: "# Tipos\n\n- B-tree\n\n![um gráfico](assets/image1.png)" },
            { type: null, markdown: "# Extra\n\n![inventada](assets/invented.png)" },
          ]
            .map((slide) => JSON.stringify(slide))
            .join("\n")
            .concat("\n"),
        };
      },
    },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-import-"));
  workspace = path.join(root, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "existing.slide.md"), "# Hello\n");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  const llm = withModel
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
    {
      mode: 0o600,
    },
  );
  studio = await startStudio(workspace, configDir, 4407);
}
test.afterEach(async () => {
  await stopStudio(studio.child);
  await stub.close();
});

async function pickFile(page: Page, name: string, buffer: Buffer) {
  await page.goto(studio.url);
  await page.getByRole("button", { name: "New deck" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New deck" });
  await dialog.getByRole("button", { name: "From a file" }).click();
  await dialog
    .getByLabel("Source file")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  return dialog;
}

test("imports a Word file as is, with its image, without a model", async ({ page }) => {
  await start(false);
  const dialog = await pickFile(page, "guide.docx", GUIDE);
  const preview = dialog.getByRole("region", { name: "What Studio read" });
  await expect(preview.getByRole("heading", { name: "Indexes" })).toBeVisible();
  await expect(preview).toContainText("guide.docx · Word · 2 sections");
  await expect(preview.getByRole("img", { name: "image1.png" })).toBeVisible();
  await expect(preview).toContainText("1 image in EMF format");
  await expect(dialog.getByLabel("Title")).toHaveValue("Indexes");
  await expect(dialog.getByLabel("Name")).toHaveValue("indexes");
  await expect(dialog.getByLabel(/Convert with AI/)).toBeDisabled();
  await expect(dialog).toContainText("Connect a model in Settings");

  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("indexes")}/slides/`));
  await expect(page.getByTestId("slide-row")).toHaveCount(3);
  expect(await fs.readdir(path.join(workspace, "indexes", "assets"))).toEqual(["image1.png"]);
  const tmp = await fs.readdir(path.join(workspace, ".flipbook-studio-tmp")).catch(() => [] as string[]);
  expect(tmp.filter((name) => name !== "sources")).toEqual([]);
  const check = flipbookCheck(path.join(workspace, "indexes"));
  if (check) expect(check.status, check.stderr).toBe(0);
});

test("imports a Markdown file as is: one slide per section, words unchanged", async ({ page }) => {
  await start(false);
  const markdown =
    "# Caching\n\nWhy it helps.\n\n## Where\n\n- CDN\n- Browser\n\n## When not\n\nData that changes every second.\n";
  const dialog = await pickFile(page, "caching.md", Buffer.from(markdown));
  const preview = dialog.getByRole("region", { name: "What Studio read" });
  await expect(preview).toContainText("caching.md · Markdown · 2 sections");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("caching")}/slides/`));
  await expect(page.getByTestId("slide-row")).toHaveCount(3);
  const slides = (await fs.readdir(path.join(workspace, "caching", "slides"))).sort();
  const texts = await Promise.all(
    slides.map((file) => fs.readFile(path.join(workspace, "caching", "slides", file), "utf8")),
  );
  expect(texts.join("\n")).toContain("- CDN\n- Browser");
  expect(texts[2]).toContain("Data that changes every second.");
  const check = flipbookCheck(path.join(workspace, "caching"));
  if (check) expect(check.status, check.stderr).toBe(0);
});

test("refuses a PDF in the browser and a Latin-1 text file on the server", async ({ page }) => {
  await start(false);
  const dialog = await pickFile(page, "report.pdf", Buffer.from("%PDF-1.7"));
  await expect(dialog.getByRole("alert")).toHaveText("Pick a Markdown, text or Word (.docx) file.");
  await dialog.getByLabel("Source file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("café", "latin1"),
  });
  await expect(dialog.getByRole("alert")).toContainText("UTF-8");
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("converts a Word file with AI, keeping its image and dropping an invented one", async ({ page }) => {
  await start(true);
  const dialog = await pickFile(page, "indices.docx", GUIDE);
  await expect(dialog.getByRole("region", { name: "What Studio read" })).toBeVisible();
  await dialog.getByLabel("Title").fill("Índices");
  await dialog.getByLabel(/Convert with AI/).check();
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("indices")}/slides/`));
  expect(prompts[0]).toContain("![a chart](assets/image1.png)");
  const slides = await fs.readdir(path.join(workspace, "indices", "slides"));
  const all = (
    await Promise.all(
      slides.map((file) => fs.readFile(path.join(workspace, "indices", "slides", file), "utf8")),
    )
  ).join("\n");
  expect(all).toContain("assets/image1.png");
  expect(all).not.toContain("invented.png");
});
