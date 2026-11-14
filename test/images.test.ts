import { describe, expect, it } from "vitest";
import {
  altFromPath,
  cleanAlt,
  formatBytes,
  hasImage,
  imageInsertion,
  imageLine,
  imageTarget,
  replaceFirstImage,
} from "../src/ui/images.js";

// US-16: the Markdown edits behind Insert image, Replace image, and drop or paste.
describe("image text edits", () => {
  it("writes a safe image line", () => {
    expect(imageLine("Team photo", "assets/team-photo.png")).toBe("![Team photo](assets/team-photo.png)");
    expect(imageTarget("assets/n ote (1).webp")).toBe("assets/n%20ote%20%281%29.webp");
    expect(cleanAlt(" a ] [b]\\\n c ")).toBe("a b c");
    expect(imageLine("x](javascript:alert(1)", "assets/a.png")).toBe(
      "![x(javascript:alert(1)](assets/a.png)",
    );
    expect(altFromPath("assets/team_photo-2.png")).toBe("team photo 2");
    expect(altFromPath("assets/.png")).toBe("image");
  });

  it("inserts the image as its own paragraph wherever the cursor is", () => {
    const line = "![a](assets/a.png)";
    expect(imageInsertion("", 0, line)).toBe(`${line}\n`);
    expect(imageInsertion("# Title", 7, line)).toBe(`\n\n${line}\n`);
    expect(imageInsertion("# Title\n", 8, line)).toBe(`\n${line}\n`);
    expect(imageInsertion("# Title\n\nText.", 9, line)).toBe(`${line}\n\n`);
    expect(imageInsertion("# Title\n\nText.", 3, line)).toBe(`\n\n${line}\n\n`);
    expect(imageInsertion("One\n\n\nTwo", 5, line)).toBe(`${line}\n`);
  });

  it("replaces only the first image's alt and target, keeping its title", () => {
    expect(hasImage("# No image\n\n[a link](x.png)")).toBe(false);
    expect(replaceFirstImage("# No image", "x", "assets/x.png")).toBeNull();
    const two = '# Two\n\n![Old](assets/old.png "Caption")\n\n![Keep](assets/keep.gif)\n';
    expect(hasImage(two)).toBe(true);
    expect(replaceFirstImage(two, "New one", "assets/new.webp")).toBe(
      '# Two\n\n![New one](assets/new.webp "Caption")\n\n![Keep](assets/keep.gif)\n',
    );
    expect(replaceFirstImage("![a \\] b](<assets/x y.png>)", "c", "assets/c.png")).toBe("![c](assets/c.png)");
    expect(replaceFirstImage("Text ![](https://example.com/a.png) end", "Local", "assets/l.png")).toBe(
      "Text ![Local](assets/l.png) end",
    );
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
