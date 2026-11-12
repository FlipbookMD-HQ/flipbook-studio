import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4394/";
const DECK_DIR = path.resolve(".e2e-edit/database-indexes-project");
const deckId = Buffer.from("database-indexes-project", "utf8").toString("base64url");
const slideUrl = (file: string) => `${STUDIO}decks/${deckId}/slides/${encodeURIComponent(`slides/${file}`)}`;
const slidePath = (file: string) => path.join(DECK_DIR, "slides", file);

async function openSlide(page: Page, file: string) {
  await page.goto(slideUrl(file));
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}

// insertText skips CodeMirror's keymap (Enter would continue a list or blockquote).
async function typeAtEnd(page: Page, text: string) {
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
}

function lineDiff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end += 1;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

test.describe.configure({ mode: "serial" });

test("edits and saves a slide; the file changes only in the edited region", async ({ page }) => {
  const before = await fs.readFile(slidePath("02-book-index.md"), "utf8");
  await openSlide(page, "02-book-index.md");
  await expect(page.getByText("eyebrow")).toBeVisible(); // read-only pass-through directive

  await typeAtEnd(page, "\n\nAdded in Studio.");
  await expect(page.getByTestId("save-status")).toHaveText("Unsaved changes");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");

  const after = await fs.readFile(slidePath("02-book-index.md"), "utf8");
  // Everything before the edit is byte-for-byte the same; the new paragraph follows the content.
  expect(after).toBe(`${before.replace(/\n$/, "")}\n\nAdded in Studio.\n`);
});

test("saving a template writes one directive line", async ({ page }) => {
  const before = await fs.readFile(slidePath("06-costs.md"), "utf8");
  await openSlide(page, "06-costs.md");
  await page.getByLabel("Template").selectOption("summary");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  const after = await fs.readFile(slidePath("06-costs.md"), "utf8");
  const diff = lineDiff(before, after);
  expect(diff.removed.length).toBeLessThanOrEqual(1);
  expect(diff.added).toEqual(["<!-- template: summary -->"]);
});

test("the preview updates within 300 ms of the last keystroke", async ({ page }) => {
  await openSlide(page, "07-choose-columns.md");
  await page.evaluate(() => {
    const w = window as unknown as { lastKey: number; updated: number | null };
    w.updated = null;
    window.addEventListener("keydown", () => (w.lastKey = performance.now()), true);
    const frame = document.querySelector('[data-testid="preview"]')!;
    new MutationObserver(() => {
      if (frame.getAttribute("srcdoc")?.includes("Zebrafish")) w.updated ??= performance.now();
    }).observe(frame, { attributes: true, attributeFilter: ["srcdoc"] });
  });
  await typeAtEnd(page, "\n\n");
  await page.keyboard.type("Zebrafish");
  await expect(page.frameLocator('[data-testid="preview"]').getByText("Zebrafish")).toBeVisible();
  const elapsed = await page.evaluate(() => {
    const w = window as unknown as { lastKey: number; updated: number };
    return w.updated - w.lastKey;
  });
  expect(elapsed).toBeLessThan(300);
});

test("a script in a slide never runs in the preview", async ({ page }) => {
  const file = slidePath("03-index-structure.md");
  await fs.appendFile(
    file,
    '\n<script>window.parent.__pwned = 1</script>\n\n<img src="x" onerror="window.parent.__pwned = 2">\n',
  );
  await openSlide(page, "03-index-structure.md");
  await typeAtEnd(page, "\n\nTrigger a draft preview.");
  const preview = page.frameLocator('[data-testid="preview"]');
  await expect(preview.getByText("Trigger a draft preview.")).toBeVisible();
  expect(await preview.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("leaving with unsaved changes asks first", async ({ page }) => {
  await openSlide(page, "08-checklist.md");
  await typeAtEnd(page, "\n\nNot saved yet.");
  await page.getByRole("link", { name: "Database Indexes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(slideUrl("08-checklist.md"));
  await page.getByRole("link", { name: "Database Indexes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Leave without saving?" })
    .getByRole("button", { name: "Leave and discard" })
    .click();
  await expect(page).toHaveURL(`${STUDIO}decks/${deckId}`);
});

test.describe("conflict dialog", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("Copy my text, then Overwrite keeps my version", async ({ page }) => {
    const file = slidePath("04-with-vs-without.md");
    await openSlide(page, "04-with-vs-without.md");
    await typeAtEnd(page, "\n\nMy edit.");
    await fs.writeFile(file, "# Rewritten in another editor\n");
    await page.getByRole("button", { name: "Save" }).click();

    const dialog = page.getByRole("dialog", { name: "Changed on disk" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("disk-version")).toHaveText("# Rewritten in another editor");

    await dialog.getByRole("button", { name: "Copy my text" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Your text is on the clipboard.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("My edit.");
    expect(await fs.readFile(file, "utf8")).toBe("# Rewritten in another editor\n");

    await dialog.getByRole("button", { name: "Overwrite with mine" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    expect(await fs.readFile(file, "utf8")).toContain("My edit.");
  });

  test("Reload discards my draft and shows the disk version", async ({ page }) => {
    const file = slidePath("05-b-tree.md");
    await openSlide(page, "05-b-tree.md");
    await typeAtEnd(page, "\n\nDraft to discard.");
    await fs.writeFile(file, "# Disk wins\n");
    await page.getByRole("button", { name: "Save" }).click();
    const dialog = page.getByRole("dialog", { name: "Changed on disk" });
    await dialog.getByRole("button", { name: "Reload (discard my changes)" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel("Markdown")).toHaveText("# Disk wins");
    await expect(page.getByTestId("save-status")).toHaveText("Saved");
    expect(await fs.readFile(file, "utf8")).toBe("# Disk wins\n");
  });
});
