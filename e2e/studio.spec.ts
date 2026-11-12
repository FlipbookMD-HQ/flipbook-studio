import { expect, test } from "@playwright/test";

const WORKSPACE = "http://127.0.0.1:4391/";
const EMPTY = "http://127.0.0.1:4392/";

test("lists every deck in the workspace and names a broken one", async ({ page }) => {
  await page.goto(WORKSPACE);
  const cards = page.getByTestId("deck-card");
  await expect(cards).toHaveCount(3);
  await expect(page.getByRole("link", { name: /Brief a Decision/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /system-design\.slide\.md/ })).toBeVisible();
  const broken = cards.filter({ hasText: "broken-deck" });
  await expect(broken.getByRole("alert")).toContainText("broken-deck");
  await expect(broken.getByRole("alert")).toContainText("missing.slide.md");
});

test("opens a deck and shows its slides as sandboxed thumbnails", async ({ page }) => {
  await page.goto(WORKSPACE);
  await page.getByRole("link", { name: /Brief a Decision/ }).click();
  await expect(page).toHaveURL(/\/decks\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Brief a Decision");
  const thumbs = page.getByTestId("slide-thumb");
  await expect(thumbs).toHaveCount(5);
  const frames = page.locator(".slide-thumb iframe");
  for (const sandbox of await frames.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("sandbox")),
  )) {
    expect(sandbox).toBe("");
  }
  // The declarative shadow root renders without scripts.
  await expect(page.frameLocator(".slide-thumb iframe").first().locator("#canvas h1")).toBeVisible();
});

test("shows an empty state with New deck for an empty folder", async ({ page }) => {
  await page.goto(EMPTY);
  const empty = page.getByTestId("empty-state");
  await expect(empty).toContainText("No decks in this folder yet");
  await expect(empty.getByRole("button", { name: "New deck" })).toBeVisible();
});

test("the API refuses requests without the launch token", async ({ page, request }) => {
  const direct = await request.get(`${WORKSPACE}api/workspace`);
  expect(direct.status()).toBe(403);
  await page.goto(WORKSPACE);
  const status = await page.evaluate(async () => (await fetch("/api/workspace")).status);
  expect(status).toBe(403);
});
