import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/server/app.js";
import { StudioError } from "../src/server/errors.js";
import {
  SOURCE_MAX_IMAGES,
  SOURCE_TTL_MS,
  SourceStore,
  readDocx,
  readText,
  zipEntries,
} from "../src/server/sources.js";
import { TMP_DIR } from "../src/server/workspace.js";
import { SOURCE_MAX_BYTES, SourceDocumentSchema } from "../src/shared/api.js";
import { PNG, buildDocx, docx, zip } from "./support/docx.js";
import { headers, makeApp, tempDir } from "./helpers.js";

// US-18 · 2.1.1: source readers (tech-spec D22).

async function codeOf(promise: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(StudioError);
    return (error as StudioError).code;
  }
  throw new Error("expected a StudioError");
}

const RICH = buildDocx({
  title: "Index guide",
  body: [
    docx.heading(1, "Indexes"),
    docx.para("Why they matter."),
    docx.heading(2, "Kinds"),
    docx.bullet("B-tree"),
    docx.bullet("Hash"),
    docx.bold("Remember this"),
    docx.table([
      ["Kind", "Speed"],
      ["B-tree", "fast"],
    ]),
    docx.image("rIdImg", "a chart"),
  ].join(""),
  images: [{ rel: "rIdImg", file: "chart.png", data: PNG }],
});

describe("readDocx", () => {
  it("turns headings, lists, bold, tables and images into Markdown", async () => {
    const read = await readDocx(RICH);
    expect(read.format).toBe("docx");
    expect(read.title).toBe("Index guide");
    expect(read.markdown).toContain("# Indexes\n\nWhy they matter.\n\n## Kinds\n\n- B-tree\n- Hash");
    expect(read.markdown).toContain("**Remember this**");
    expect(read.markdown).toContain("| Kind | Speed |\n| --- | --- |\n| B-tree | fast |");
    expect(read.markdown).toContain("![a chart](image1.png)");
    expect(read.images).toEqual([{ fileName: "image1.png", bytes: PNG }]);
    expect(read.dropped).toEqual([]);
  });

  it("keeps EMF and TIFF images for the asset check, and drops linked images", async () => {
    const read = await readDocx(
      buildDocx({
        body: [
          docx.image("rIdEmf", "vector"),
          docx.image("rIdTiff", "scan"),
          docx.image("rIdLink", "remote", true),
        ].join(""),
        images: [
          { rel: "rIdEmf", file: "v.emf", data: Buffer.from("EMF") },
          { rel: "rIdTiff", file: "s.tiff", data: Buffer.from("II*\u0000") },
        ],
        links: [{ rel: "rIdLink", target: "file:///etc/passwd" }],
      }),
    );
    expect(read.images.map((image) => image.fileName)).toEqual(["image1.emf", "image2.tiff"]);
    expect(read.dropped).toEqual([{ kind: "linked-image", reason: "not-embedded", count: 1 }]);
    expect(read.markdown).not.toContain("remote");
  });

  it(`keeps the first ${SOURCE_MAX_IMAGES} images and counts the rest`, async () => {
    const count = SOURCE_MAX_IMAGES + 3;
    const read = await readDocx(
      buildDocx({
        body: Array.from({ length: count }, (_, i) => docx.image(`rId${i}`, `pic ${i}`)).join(""),
        images: Array.from({ length: count }, (_, i) => ({ rel: `rId${i}`, file: `p${i}.png`, data: PNG })),
      }),
    );
    expect(read.images).toHaveLength(SOURCE_MAX_IMAGES);
    expect(read.dropped).toEqual([{ kind: "image", reason: "limit", count: 3 }]);
    expect(read.markdown).not.toContain(`pic ${count - 1}`);
  });

  it("reads a docx with only images", async () => {
    const read = await readDocx(
      buildDocx({
        body: docx.image("rIdImg", "only"),
        images: [{ rel: "rIdImg", file: "a.png", data: PNG }],
      }),
    );
    expect(read.markdown.trim()).toBe("![only](image1.png)");
  });

  it("refuses a zip bomb before inflating anything", async () => {
    const bomb = zip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "word/document.xml", data: Buffer.alloc(1000), declaredSize: 200 * 1024 * 1024 },
    ]);
    expect(await codeOf(() => zipEntries(bomb))).toBe("SOURCE_TOO_LARGE");
    expect(await codeOf(readDocx(bomb))).toBe("SOURCE_TOO_LARGE");
  });

  it("refuses more than 2,000 entries", async () => {
    const many = zip(
      Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}`, data: Buffer.from("x") })),
      {
        deflate: false,
      },
    );
    expect(await codeOf(() => zipEntries(many))).toBe("SOURCE_TOO_LARGE");
  });

  it("refuses encrypted, corrupt and non-Word files", async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600),
    ]);
    expect(await codeOf(readDocx(ole))).toBe("SOURCE_UNREADABLE");
    expect(await codeOf(readDocx(RICH.subarray(0, RICH.length - 30)))).toBe("SOURCE_UNREADABLE");
    expect(await codeOf(readDocx(Buffer.from("%PDF-1.7 not a zip")))).toBe("SOURCE_TYPE");
    const notWord = zip([{ name: "hello.txt", data: Buffer.from("hi") }]);
    expect(await codeOf(readDocx(notWord))).toBe("SOURCE_TYPE");
  });
});

describe("readText", () => {
  it("reads UTF-8 and strips a BOM", () => {
    expect(readText(Buffer.from("\uFEFF# Título\n"), "md").markdown).toBe("# Título\n");
  });

  it("refuses UTF-16 and Latin-1 with a message naming UTF-8", async () => {
    const utf16 = Buffer.from("\uFEFF# Title\n", "utf16le");
    const latin1 = Buffer.from("# Título\n", "latin1");
    for (const bytes of [utf16, latin1]) {
      try {
        readText(bytes, "txt");
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as StudioError).code).toBe("SOURCE_ENCODING");
        expect((error as Error).message).toContain("UTF-8");
      }
    }
  });
});

// US-18 · 2.1.2: POST /api/sources (D24).

async function setup() {
  const root = await tempDir();
  const app = await makeApp(root);
  const upload = (name: string, bytes: Buffer, extra: Record<string, string | null> = {}) => {
    const form = new FormData();
    form.append("file", new File([Buffer.from(bytes)], name));
    return app.request("/api/sources", { method: "POST", headers: headers(extra), body: form });
  };
  const sourcesDir = path.join(root, TMP_DIR, "sources");
  return { root, app, upload, sourcesDir };
}

describe("POST /api/sources", () => {
  it("previews a .docx: title, counts, image thumbnails and drops", async () => {
    const { upload, sourcesDir } = await setup();
    const response = await upload("Guide.docx", RICH);
    expect(response.status).toBe(201);
    const { source } = await response.json();
    expect(SourceDocumentSchema.safeParse(source).success).toBe(true);
    expect(source).toMatchObject({
      fileName: "Guide.docx",
      format: "docx",
      title: "Indexes",
      sections: 1,
      dropped: [],
    });
    expect(source.images).toEqual([
      expect.objectContaining({
        id: "image1.png",
        width: 40,
        height: 30,
        thumbnail: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    ]);
    expect(await fs.readdir(sourcesDir)).toEqual([source.sourceId]);
  });

  it("previews .md and .txt, using the file name when there is no title", async () => {
    const { upload } = await setup();
    const md = await (
      await upload("notes.md", Buffer.from("## One\n\nx\n\n## Two\n\n![p](pics/p.png)\n"))
    ).json();
    expect(md.source).toMatchObject({ format: "md", title: "notes", sections: 2 });
    expect(md.source.dropped).toEqual([
      { kind: "relative-image", reason: "not-uploaded", count: 1, detail: "pics/p.png" },
    ]);
    const txt = await (await upload("plain.txt", Buffer.from("Just a paragraph.\n"))).json();
    expect(txt.source).toMatchObject({ format: "txt", title: "plain", sections: 0 });
  });

  it("lists images that fail the upload check by format", async () => {
    const { upload } = await setup();
    const doc = buildDocx({
      body: [docx.para("Text"), docx.image("rIdEmf", "v"), docx.image("rIdBad", "b")].join(""),
      images: [
        { rel: "rIdEmf", file: "v.emf", data: Buffer.from("EMF") },
        { rel: "rIdBad", file: "b.png", data: Buffer.from("<html>") },
      ],
    });
    const { source } = await (await upload("pics.docx", doc)).json();
    expect(source.images).toEqual([]);
    expect(source.dropped).toEqual([
      { kind: "image", reason: "type", count: 1, detail: "EMF" },
      { kind: "image", reason: "type", count: 1, detail: "PNG" },
    ]);
  });

  it("refuses wrong types, bad encodings, empty files and a .docx that isn't a zip; nothing is stored", async () => {
    const { upload, sourcesDir } = await setup();
    const cases: [string, Buffer, number, string][] = [
      ["report.pdf", Buffer.from("%PDF-1.7"), 415, "SOURCE_TYPE"],
      ["fake.docx", Buffer.from("not a zip at all"), 415, "SOURCE_TYPE"],
      ["latin.txt", Buffer.from("café", "latin1"), 422, "SOURCE_ENCODING"],
      ["empty.md", Buffer.from("  \n\n"), 422, "VALIDATION_FAILED"],
    ];
    for (const [name, bytes, status, code] of cases) {
      const response = await upload(name, bytes);
      expect(response.status, name).toBe(status);
      expect((await response.json()).error.code, name).toBe(code);
    }
    expect(await fs.readdir(sourcesDir).catch(() => [])).toEqual([]);
  });

  it("cuts a body over 25 MB with 413 and stores nothing; other routes keep the 2 MB limit", async () => {
    const { app, upload, sourcesDir } = await setup();
    const response = await upload("big.md", Buffer.alloc(SOURCE_MAX_BYTES + 1, 0x61));
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("SOURCE_TOO_LARGE");
    await expect(fs.readdir(sourcesDir)).rejects.toThrow();
    const big = await app.request("/api/decks/import", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 10) }),
    });
    expect(big.status).toBe(413);
  });

  it("needs the token and a same-origin request", async () => {
    const { upload } = await setup();
    expect((await upload("a.md", Buffer.from("# A\n"), { "x-flipbook-token": null })).status).toBe(403);
    expect((await upload("a.md", Buffer.from("# A\n"), { origin: "https://evil.test" })).status).toBe(403);
    expect((await upload("a.md", Buffer.from("# A\n"), { host: "evil.test" })).status).toBe(403);
  });
});

describe("SourceStore expiry", () => {
  it("forgets a source after 30 minutes and sweeps it from disk", async () => {
    const root = await tempDir();
    let now = Date.parse("2026-11-14T12:00:00Z");
    const store = new SourceStore(() => now);
    const doc = await store.save(root, "a.md", Buffer.from("# A\n\nx\n"));
    expect(doc.expiresAt).toBe(new Date(now + SOURCE_TTL_MS).toISOString());
    expect((await store.get(root, doc.sourceId)).markdown).toBe("# A\n\nx\n");
    now += SOURCE_TTL_MS + 1;
    await store.sweep(root);
    await expect(fs.readdir(path.join(root, TMP_DIR, "sources"))).resolves.toEqual([]);
    await expect(store.get(root, doc.sourceId)).rejects.toMatchObject({ code: "SOURCE_EXPIRED" });
    await expect(store.get(root, "../../etc")).rejects.toMatchObject({ code: "SOURCE_EXPIRED" });
  });
});
