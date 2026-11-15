import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { expect, test, type Page, type Request } from "@playwright/test";
import { startStudio, stopStudio } from "./support/studio";

// US-16: deck images, on a Studio of its own (port 4405) and a deck without a blueprint.
const id = (relative: string) => Buffer.from(relative, "utf8").toString("base64url");
const DECK = id("talk");
const SLIDE_1 = "slides/01_cover.slide.md";
const SLIDE_2 = "slides/02_point.slide.md";

/** A real, solid-colour PNG the browser can draw. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([r, g, b]))]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const RED = png(320, 200, [255, 0, 0]);
const BLUE = png(64, 64, [0, 0, 255]);

let workspace: string;
let studio: Awaited<ReturnType<typeof startStudio>>;

test.beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-images-"));
  workspace = path.join(root, "ws");
  await fs.mkdir(path.join(workspace, "talk/slides"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "talk/presentation.yml"),
    `title: Talk\nslides:\n  - ${SLIDE_1}\n  - ${SLIDE_2}\n`,
  );
  await fs.writeFile(path.join(workspace, "talk", SLIDE_1), "# Cover\n\nOne line.\n");
  await fs.writeFile(path.join(workspace, "talk", SLIDE_2), "# Point\n\nText.\n");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { mode: 0o700 });
  studio = await startStudio(workspace, configDir, 4405, path.join(root, "library"));
});
test.afterEach(async () => {
  await stopStudio(studio.child);
});

const assetsDir = () => path.join(workspace, "talk/assets");
const listAssets = () => fs.readdir(assetsDir()).catch(() => [] as string[]);
const slideText = (slide: string) => fs.readFile(path.join(workspace, "talk", slide), "utf8");

/** Uploads on the deck screen and waits until every file's request is done (accepted, refused or
 * dropped), so a navigation right after can't abort an upload still in flight. */
async function uploadOnDeck(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.goto(`${studio.url}decks/${DECK}`);
  let done = 0;
  const allAnswered = new Promise<void>((resolve) => {
    const onDone = (request: Request) => {
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/assets")) return;
      done += 1;
      if (done < files.length) return;
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      resolve();
    };
    page.on("requestfinished", onDone);
    page.on("requestfailed", onDone);
  });
  await page.getByLabel("Image files").setInputFiles(files);
  await allAnswered;
}
async function openSlide(page: Page, slide: string) {
  await page.goto(`${studio.url}decks/${DECK}/slides/${encodeURIComponent(slide)}`);
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
async function save(page: Page) {
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
}
/** Width of the first image the slide preview drew (0 when broken or missing). */
const previewImageWidth = (page: Page) =>
  page
    .frameLocator('iframe[title="Slide preview"]')
    .locator("img")
    .first()
    .evaluate((img: HTMLImageElement) => img.naturalWidth);

/** Fires a drop or paste of `file` at the end of the Markdown editor. */
async function sendFile(
  page: Page,
  kind: "drop" | "paste",
  file: { name: string; type: string; base64: string },
) {
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.getByLabel("Markdown").evaluate(
    (content, { kind, file }) => {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
      if (kind === "paste") {
        content.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      } else {
        const box = content.getBoundingClientRect();
        content.dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: box.left + 5,
            clientY: box.bottom - 5,
          }),
        );
      }
    },
    { kind, file },
  );
}

test("an upload shows in the deck's images with its size and dimensions, under a safe name", async ({
  page,
}) => {
  await uploadOnDeck(page, [{ name: "Red Square.PNG", mimeType: "image/png", buffer: RED }]);
  const card = page.getByTestId("image-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("red-square.png");
  await expect(card).toContainText("320 × 200");
  await expect(card).toContainText("Not used");
  await expect(card.locator("img")).toHaveJSProperty("naturalWidth", 320);

  // The same name again never overwrites.
  await page
    .getByLabel("Image files")
    .setInputFiles([{ name: "red square.png", mimeType: "image/png", buffer: BLUE }]);
  await expect(page.getByTestId("image-card")).toHaveCount(2);
  expect((await listAssets()).sort()).toEqual(["red-square-2.png", "red-square.png"]);
  expect(await fs.readFile(path.join(assetsDir(), "red-square.png"))).toEqual(RED);
});

test("Insert image puts it at the cursor; the preview and the PNG export show it", async ({ page }) => {
  await uploadOnDeck(page, [{ name: "red.png", mimeType: "image/png", buffer: RED }]);
  await expect(page.getByTestId("image-card")).toHaveCount(1);
  await openSlide(page, SLIDE_1);
  await page.getByLabel("Markdown").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "Insert image" }).click();
  const dialog = page.getByRole("dialog", { name: "Insert image" });
  await dialog.getByRole("button", { name: "Choose" }).click();
  await expect(dialog.getByLabel("Alt text")).toHaveValue("red");
  await dialog.getByLabel("Alt text").fill("A red block");
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => previewImageWidth(page)).toBe(320);
  await save(page);
  expect(await slideText(SLIDE_1)).toBe("# Cover\n\nOne line.\n\n![A red block](assets/red.png)\n");

  // Replace image swaps the first image only.
  await uploadOnDeck(page, [{ name: "blue.png", mimeType: "image/png", buffer: BLUE }]);
  await openSlide(page, SLIDE_1);
  await page.getByRole("button", { name: "Insert image" }).click();
  await dialog
    .getByTestId("image-card")
    .filter({ hasText: "blue.png" })
    .getByRole("button", { name: "Choose" })
    .click();
  await dialog.getByRole("button", { name: "Replace image" }).click();
  await expect.poll(() => previewImageWidth(page)).toBe(64);
  await save(page);
  expect(await slideText(SLIDE_1)).toBe("# Cover\n\nOne line.\n\n![blue](assets/blue.png)\n");

  // The PNG export draws it: the exported cover has blue pixels.
  await page.goto(`${studio.url}decks/${DECK}`);
  await page.getByRole("button", { name: "Export…" }).click();
  const exporter = page.getByRole("dialog", { name: "Export" });
  await exporter.getByLabel("Preset").selectOption("instagram");
  await exporter.getByLabel("Output folder (in the workspace)").fill("exports/images");
  await exporter.getByRole("button", { name: "Start export" }).click();
  await expect(exporter.getByTestId("export-status")).toContainText("Done:", { timeout: 60_000 });
  const pngs = (await fs.readdir(path.join(workspace, "exports/images")))
    .filter((name) => name.endsWith(".png"))
    .sort();
  const cover = await fs.readFile(path.join(workspace, "exports/images", pngs[0]!));
  const blue = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i]! < 30 && data[i + 1]! < 30 && data[i + 2]! > 220) count += 1;
    return count;
  }, cover.toString("base64"));
  expect(blue).toBeGreaterThan(1000);
});

test("dropping or pasting an image into the Markdown uploads and inserts it", async ({ page }) => {
  await openSlide(page, SLIDE_2);
  await sendFile(page, "drop", {
    name: "Dropped Shot.png",
    type: "image/png",
    base64: RED.toString("base64"),
  });
  await expect.poll(() => previewImageWidth(page)).toBe(320);
  await sendFile(page, "paste", { name: "image.png", type: "image/png", base64: BLUE.toString("base64") });
  await expect(page.frameLocator('iframe[title="Slide preview"]').locator("img")).toHaveCount(2);
  await save(page);
  const text = await slideText(SLIDE_2);
  expect(text).toContain("![dropped shot](assets/dropped-shot.png)");
  expect(text).toContain("![image](assets/image.png)");
  expect((await listAssets()).sort()).toEqual(["dropped-shot.png", "image.png"]);
});

test("refused files show why, write nothing and leave the Markdown alone", async ({ page }) => {
  await uploadOnDeck(page, [
    {
      name: "fake.png",
      mimeType: "image/png",
      buffer: Buffer.from("<html><script>alert(1)</script></html>"),
    },
    { name: "huge.png", mimeType: "image/png", buffer: Buffer.concat([RED, Buffer.alloc(9 * 1024 * 1024)]) },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  const errors = page.getByTestId("upload-errors");
  await expect(errors).toContainText("fake.png: This file isn't a real PNG image.");
  await expect(errors).toContainText("huge.png: Images can be at most 8 MB.");
  await expect(errors).toContainText("notes.txt: Upload a PNG, JPEG, GIF, WebP or SVG image.");
  await expect(page.getByTestId("images-empty")).toBeVisible();
  expect(await listAssets()).toEqual([]);

  await openSlide(page, SLIDE_2);
  await sendFile(page, "drop", {
    name: "fake.gif",
    type: "image/gif",
    base64: Buffer.from("nope").toString("base64"),
  });
  await expect(page.getByTestId("upload-errors")).toContainText(
    "fake.gif: This file isn't a real GIF image.",
  );
  await expect(page.getByTestId("save-status")).toHaveText("Saved");
  expect(await slideText(SLIDE_2)).toBe("# Point\n\nText.\n");
});

test("deleting a used image lists its slides and asks first; an unused one goes at once", async ({
  page,
}) => {
  await fs.mkdir(assetsDir());
  await fs.writeFile(path.join(assetsDir(), "used.png"), RED);
  await fs.writeFile(path.join(assetsDir(), "spare.png"), BLUE);
  await fs.writeFile(path.join(workspace, "talk", SLIDE_2), "# Point\n\n![Used](assets/used.png)\n");
  await page.goto(`${studio.url}decks/${DECK}`);
  const spare = page.getByTestId("image-card").filter({ hasText: "spare.png" });
  await spare.getByRole("button", { name: /Delete/ }).click();
  await expect(spare).toHaveCount(0);
  expect(await listAssets()).toEqual(["used.png"]);

  const used = page.getByTestId("image-card").filter({ hasText: "used.png" });
  await expect(used.getByTestId("image-usage")).toHaveText("Used by 2. Point");
  await used.getByRole("button", { name: /Delete/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete used.png?" });
  await expect(confirm.getByTestId("image-used-by")).toHaveText("2. Point");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(await listAssets()).toEqual(["used.png"]);
  await used.getByRole("button", { name: /Delete/ }).click();
  await confirm.getByRole("button", { name: "Delete anyway" }).click();
  await expect(page.getByTestId("images-empty")).toBeVisible();
  expect(await listAssets()).toEqual([]);
});

test("a script inside an uploaded SVG never runs", async ({ page }) => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="top.document.title=\'pwned\'"><script>top.document.title="pwned"</script><rect width="10" height="10"/></svg>',
  );
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await uploadOnDeck(page, [{ name: "evil.svg", mimeType: "image/svg+xml", buffer: svg }]);
  await expect(page.getByTestId("image-card")).toContainText("10 × 10");
  await openSlide(page, SLIDE_1);
  await page.getByRole("button", { name: "Insert image" }).click();
  await page.getByRole("dialog", { name: "Insert image" }).getByRole("button", { name: "Choose" }).click();
  await page
    .getByRole("dialog", { name: "Insert image" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect.poll(() => previewImageWidth(page)).toBe(10);
  expect(await page.title()).not.toBe("pwned");
  await save(page);

  // Opened directly, the file is sandboxed too (Chrome may abort the navigation outright).
  await page.goto(`${studio.url}api/decks/${DECK}/files/assets/evil.svg`).catch(() => null);
  await page.waitForTimeout(300);
  expect(await page.title()).not.toBe("pwned");
  expect(dialogs).toEqual([]);
});
