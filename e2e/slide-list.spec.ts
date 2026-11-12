import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const STUDIO = "http://127.0.0.1:4394/";
const WORKSPACE = path.resolve(".e2e-edit");
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const open = async (page: Page, deck: string, slideId: string) => {
  await page.goto(`${STUDIO}decks/${id(deck)}/slides/${encodeURIComponent(slideId)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
};
const rows = (page: Page) => page.getByTestId("slide-row");
const read = (relative: string) => fs.readFile(path.join(WORKSPACE, relative), "utf8");
const slideFiles = async () => (await fs.readdir(path.join(WORKSPACE, "order-deck/slides"))).sort();
const manifestSlides = async () =>
  (await read("order-deck/presentation.yml"))
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.trim().replace(/^- /, "").replace(/ #.*$/, ""));

test.describe.configure({ mode: "serial" });

test.describe("folder deck", () => {
  test("Add slide after writes a new file and a manifest entry, then opens it", async ({ page }) => {
    await open(page, "order-deck", "slides/01_first.slide.md");
    await page.getByRole("button", { name: "Add slide after" }).click();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent("slides/04_slide.slide.md")));
    await expect(rows(page)).toHaveText(["⠿1. First", "⠿2. New slide", "⠿3. Second", "⠿4. Third"]);
    expect(await manifestSlides()).toEqual([
      "slides/01_first.slide.md",
      "slides/04_slide.slide.md",
      "slides/02_second.slide.md",
      "slides/03_third.slide.md",
    ]);
    expect(await read("order-deck/slides/04_slide.slide.md")).toBe("# New slide\n");
    expect(await read("order-deck/presentation.yml")).toContain("# Order test deck");
  });

  test("dragging with the keyboard changes only the manifest order", async ({ page }) => {
    await open(page, "order-deck", "slides/01_first.slide.md");
    const files = await slideFiles();
    const contents = await Promise.all(files.map((file) => read(`order-deck/slides/${file}`)));
    await page.getByRole("button", { name: "Move slide 1. First" }).focus();
    // dnd-kit measures the list between steps, so give each key a moment.
    for (const key of ["Space", "ArrowDown", "ArrowDown", "Space"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
    }
    await expect(rows(page)).toHaveText(["⠿1. New slide", "⠿2. Second", "⠿3. First", "⠿4. Third"]);
    await expect
      .poll(manifestSlides)
      .toEqual([
        "slides/04_slide.slide.md",
        "slides/02_second.slide.md",
        "slides/01_first.slide.md",
        "slides/03_third.slide.md",
      ]);
    expect(await slideFiles()).toEqual(files);
    expect(await Promise.all(files.map((file) => read(`order-deck/slides/${file}`)))).toEqual(contents);
    await expect(page.getByRole("link", { name: "3. First" })).toHaveAttribute("aria-current", "page");
  });

  test("cancelling a delete changes nothing; confirming removes the entry and the file", async ({ page }) => {
    await open(page, "order-deck", "slides/02_second.slide.md");
    const manifest = await read("order-deck/presentation.yml");
    await page.getByRole("button", { name: "Delete slide" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete slide 2?" });
    await expect(dialog).toContainText("slides/02_second.slide.md");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await read("order-deck/presentation.yml")).toBe(manifest);
    expect(await slideFiles()).toContain("02_second.slide.md");

    await page.getByRole("button", { name: "Delete slide" }).click();
    await page
      .getByRole("dialog", { name: "Delete slide 2?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(rows(page)).toHaveCount(3);
    expect(await slideFiles()).not.toContain("02_second.slide.md");
    expect(await manifestSlides()).not.toContain("slides/02_second.slide.md");
    // The slide now at position 2 is open.
    await expect(page.getByRole("link", { name: "2. First" })).toHaveAttribute("aria-current", "page");
  });

  test("structure changes wait until the open slide is saved", async ({ page }) => {
    await open(page, "order-deck", "slides/03_third.slide.md");
    await page.getByLabel("Markdown").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" edited");
    const add = page.getByRole("button", { name: "Add slide after" });
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute("title", "Save or discard your changes first.");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(add).toBeEnabled();
  });
});

test("a refused reorder rolls back and says why", async ({ page }) => {
  await open(page, "order-deck", "slides/01_first.slide.md");
  const before = await rows(page).allTextContents();
  // Another app edits the manifest after Studio loaded it.
  const manifest = path.join(WORKSPACE, "order-deck/presentation.yml");
  await fs.appendFile(manifest, "# edited elsewhere\n");
  const edited = await fs.readFile(manifest, "utf8");
  await page.getByRole("button", { name: /^Move slide 1\./ }).focus();
  for (const key of ["Space", "ArrowDown", "Space"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  await expect(page.getByRole("alert")).toContainText("The deck changed on disk");
  await expect(rows(page)).toHaveText(before);
  expect(await fs.readFile(manifest, "utf8")).toBe(edited);
});

test.describe("single-file deck", () => {
  const FILE = "order-single.slide.md";

  test("add, mouse drag and delete rewrite separators and keep each chunk's bytes", async ({ page }) => {
    await open(page, FILE, "#0");
    await page.getByRole("button", { name: "Add slide after" }).click();
    await expect(page).toHaveURL(new RegExp(`${encodeURIComponent("#1")}$`));
    expect(await read(FILE)).toBe(
      "---\ntitle: Order Single\n---\n\n# One\n\nAlpha text.\n\n---\n\n# New slide\n\n---\n\n# Two\n\n---\n\n# Three\n",
    );

    // Drag "Three" to the top with the mouse.
    const handle = page.getByRole("button", { name: "Move slide 4. Three" });
    const target = page.getByRole("button", { name: "Move slide 1. One" });
    const from = (await handle.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 12 });
    await page.mouse.up();
    // dnd-kit swallows clicks for 50 ms after a pointer drag; don't let the next click land in it.
    await page.waitForTimeout(250);
    await expect(rows(page)).toHaveText(["⠿1. Three", "⠿2. One", "⠿3. New slide", "⠿4. Two"]);
    await expect
      .poll(() => read(FILE))
      .toBe(
        "---\ntitle: Order Single\n---\n\n# Three\n\n---\n\n# One\n\nAlpha text.\n\n---\n\n# New slide\n\n---\n\n# Two\n",
      );
    // The open slide follows its new position.
    await expect(page).toHaveURL(new RegExp(`${encodeURIComponent("#2")}$`));

    await page.getByRole("button", { name: "Delete slide" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete slide 3?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await read(FILE)).toContain("# New slide");
    await page.getByRole("button", { name: "Delete slide" }).click();
    await page
      .getByRole("dialog", { name: "Delete slide 3?" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(rows(page)).toHaveCount(3);
    expect(await read(FILE)).toBe(
      "---\ntitle: Order Single\n---\n\n# Three\n\n---\n\n# One\n\nAlpha text.\n\n---\n\n# Two\n",
    );
  });

  test("the last slide can't be deleted", async ({ page }) => {
    await open(page, "lonely.slide.md", "#0");
    const remove = page.getByRole("button", { name: "Delete slide" });
    await expect(remove).toBeDisabled();
    await expect(remove).toHaveAttribute("title", "A deck needs at least one slide.");
    expect(await read("lonely.slide.md")).toBe("# Only slide\n");
  });
});
