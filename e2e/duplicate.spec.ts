import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startStudio, stopStudio } from "./support/studio";

// US-20: duplicate decks and kit pieces, on a Studio of its own (port 4408) with a temp library.
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");

/** `flipbook check`'s result: FLIPBOOK_CLI, else a sibling flipbook-md checkout, else null. */
function flipbookCheck(target: string, library: string) {
  const sibling = path.resolve("../flipbook-md/bin/flipbook.js");
  const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
  if (!cli) return null;
  return spawnSync(process.execPath, [cli, "check", target], {
    encoding: "utf8",
    env: { ...process.env, FLIPBOOK_HOME: library },
  });
}

async function write(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

async function snapshot(dir: string) {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      out[path.relative(dir, full)] = await fs.readFile(full, "utf8");
    }
  }
  return out;
}

let workspace: string;
let library: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

test.beforeEach(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "studio-duplicate-")));
  workspace = path.join(root, "ws");
  library = path.join(root, "library");
  await write(workspace, {
    "talk/presentation.yml": "# Q3\ntitle: Talk\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n",
    "talk/slides/01.slide.md": "# First\n\n![logo](../assets/logo.svg)\n",
    "talk/slides/02.slide.md": "# Second\n\nText.\n",
    "talk/assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
    "talk/dist/talk.pdf": "old export",
    "solo.slide.md": "---\ntitle: Solo\n---\n# One\n\n---\n\n# Two\n",
  });
  await write(library, {
    "templates/quote.yml": "column: 1\nrow: 2\nwidth: 3\nheight: 1\nalign: start\n",
    "blueprints/talk.yml": "pages:\n  - type: cover\ntypes:\n  cover:\n    template: cover\n",
  });
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  studio = await startStudio(workspace, configDir, 4408, library);
});
test.afterEach(async () => {
  await stopStudio(studio.child);
});

test("duplicates a folder deck from its card and a single-file deck from its screen", async ({ page }) => {
  const original = await snapshot(path.join(workspace, "talk"));
  await page.goto(studio.url);
  await page
    .getByTestId("deck-card")
    .filter({ hasText: "Talk" })
    .getByRole("button", { name: "Duplicate" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Duplicate deck" });
  await expect(dialog.getByLabel("Title")).toHaveValue("Talk (copy)");
  await expect(dialog.getByLabel("Name")).toHaveValue("talk-copy");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/decks/${id("talk-copy")}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Talk (copy)" })).toBeVisible();
  await expect(page.getByTestId("duplicated-notice")).toContainText("Duplicated from Talk");
  await expect(page.getByTestId("slide-thumb")).toHaveCount(2);
  expect(await snapshot(path.join(workspace, "talk"))).toEqual(original);
  const copy = await snapshot(path.join(workspace, "talk-copy"));
  expect(Object.keys(copy).sort()).toEqual(
    Object.keys(original)
      .filter((name) => !name.startsWith("dist"))
      .sort(),
  );
  const checks = ["talk", "talk-copy"].map((name) => flipbookCheck(path.join(workspace, name), library));
  if (checks[0] && checks[1]) {
    expect(checks[1].status).toBe(checks[0].status);
    expect(checks[1].status, checks[1].stderr).toBe(0);
  }

  await page.goto(`${new URL(studio.url).origin}/decks/${id("solo.slide.md")}`);
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  const single = page.getByRole("dialog", { name: "Duplicate deck" });
  await expect(single.getByLabel("Name")).toHaveValue("solo-copy");
  await single.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id("solo-copy.slide.md")}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Solo (copy)" })).toBeVisible();
  await expect(page.getByTestId("slide-thumb")).toHaveCount(2);
  expect(await fs.readFile(path.join(workspace, "solo.slide.md"), "utf8")).toBe(
    "---\ntitle: Solo\n---\n# One\n\n---\n\n# Two\n",
  );
});

test("refuses a taken deck name and keeps the dialog open", async ({ page }) => {
  await page.goto(studio.url);
  await page
    .getByTestId("deck-card")
    .filter({ hasText: "Talk" })
    .getByRole("button", { name: "Duplicate" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Duplicate deck" });
  await dialog.getByLabel("Name").fill("talk");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await expect(dialog).toBeVisible();
  expect((await fs.readdir(workspace)).sort()).toEqual(["solo.slide.md", "talk"]);
});

test("duplicates a built-in theme, a template, a blueprint and a media kit", async ({ page }) => {
  const base = new URL(studio.url).origin;
  const duplicate = async (list: string, name: string, kind: string, expected: string, url: string) => {
    await page.goto(`${base}${list}`);
    await page.getByRole("button", { name: `Duplicate ${name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Duplicate ${kind}` });
    await expect(dialog.getByLabel("Name of the copy")).toHaveValue(expected);
    await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${url}$`));
  };
  await duplicate(
    "/kits/themes",
    "marvel-jarvis",
    "theme",
    "marvel-jarvis-copy",
    "/kits/themes/library/marvel-jarvis-copy",
  );
  expect(await fs.readFile(path.join(library, "themes", "marvel-jarvis-copy.css"), "utf8")).toContain("{");
  await duplicate("/kits/templates", "quote", "template", "quote-copy", "/kits/templates/library/quote-copy");
  expect(await fs.readFile(path.join(library, "templates", "quote-copy.yml"), "utf8")).toBe(
    "column: 1\nrow: 2\nwidth: 3\nheight: 1\nalign: start\n",
  );
  await duplicate("/kits/blueprints", "talk", "blueprint", "talk-copy", "/kits/blueprints/library/talk-copy");
  await duplicate(
    "/kits/media",
    "marvel_content_guide",
    "media kit",
    "marvel_content_guide-copy",
    "/kits/media/library/marvel_content_guide-copy",
  );
  expect(await fs.readFile(path.join(library, "templates", "marvel_content_guide-copy.yml"), "utf8")).toMatch(
    /marvel_content_guide-copy_/,
  );

  // From an editor, and a taken name is refused with nothing written.
  await page.goto(`${base}/kits/blueprints/library/talk`);
  await page.getByRole("button", { name: "Duplicate talk" }).click();
  const dialog = page.getByRole("dialog", { name: "Duplicate blueprint" });
  await dialog.getByLabel("Name of the copy").fill("talk-copy");
  await dialog.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  expect((await fs.readdir(path.join(library, "blueprints"))).sort()).toEqual(["talk-copy.yml", "talk.yml"]);
});
