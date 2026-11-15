import { describe, expect, it } from "vitest";
import { droppedText, plural } from "../src/ui/sourceText.js";

// US-18 · 2.2.2: what the "From a file" preview says it left out.
describe("droppedText", () => {
  it("words every kind of dropped content", () => {
    expect(droppedText({ kind: "image", reason: "type", count: 2, detail: "EMF" })).toBe(
      "2 images in EMF format",
    );
    expect(droppedText({ kind: "image", reason: "size", count: 1 })).toBe("1 image over 8 MB");
    expect(droppedText({ kind: "image", reason: "limit", count: 3 })).toBe("3 images past the first 50");
    expect(droppedText({ kind: "linked-image", reason: "not-embedded", count: 1 })).toBe(
      "1 linked image not stored in the file",
    );
    expect(
      droppedText({ kind: "relative-image", reason: "not-uploaded", count: 1, detail: "pics/a.png" }),
    ).toBe("1 image link to a file that wasn't uploaded (pics/a.png)");
    expect(droppedText({ kind: "html", reason: "removed", count: 4 })).toBe("4 pieces of raw HTML");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "section")).toBe("1 section");
    expect(plural(0, "section")).toBe("0 sections");
  });
});
