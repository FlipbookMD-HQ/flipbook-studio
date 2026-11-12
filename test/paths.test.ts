import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeDeckId, encodeDeckId, resolveInside } from "../src/server/paths.js";
import { tempDir, write } from "./helpers.js";

describe("resolveInside", () => {
  it("resolves files inside the root", async () => {
    const root = await tempDir();
    await write(root, { "a/b.txt": "x" });
    expect(await resolveInside(root, "a/b.txt")).toBe(path.join(root, "a/b.txt"));
    expect(await resolveInside(root, "a/missing.txt")).toBe(path.join(root, "a/missing.txt"));
  });

  it.each(["../x", "a/../../x", "/etc/passwd", "C:/Windows", "a\0b"])("rejects %j", async (relative) => {
    const root = await tempDir();
    await expect(resolveInside(root, relative)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
      status: 403,
    });
  });

  it("does not decode twice: %2e%2e stays a literal name", async () => {
    const root = await tempDir();
    expect(await resolveInside(root, "%2e%2e/x")).toBe(path.join(root, "%2e%2e/x"));
  });

  it("rejects a symlink whose real path leaves the root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await write(outside, { "secret.txt": "s" });
    await fs.symlink(outside, path.join(root, "link"));
    await expect(resolveInside(root, "link/secret.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
  });
});

describe("deck IDs", () => {
  it.each(["talk", "my deck.slide.md", "café/ü", "日本語"])("round-trips %j as base64url", (relative) => {
    const id = encodeDeckId(relative);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDeckId(id)).toBe(relative);
  });

  it.each(["", "not base64!", "dGFsaw=="])("refuses %j", (id) => {
    expect(() => decodeDeckId(id)).toThrow(expect.objectContaining({ code: "DECK_NOT_FOUND" }));
  });
});
