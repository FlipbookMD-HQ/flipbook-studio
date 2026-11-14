import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeckJournal, MAX_JOURNAL_BYTES, MAX_STEPS } from "../src/server/journal.js";
import type { DeckEntry } from "../src/server/workspace.js";
import { tempDir, write } from "./helpers.js";

// US-17 (D21): the change journal on its own, against temp folders.
async function folderDeck() {
  const root = await tempDir();
  await write(root, {
    "talk/presentation.yml": "title: Talk\nslides:\n  - slides/01.slide.md\n",
    "talk/slides/01.slide.md": "# One\n",
    "talk/exports/out.png": "export",
    "talk/.cache/x": "hidden",
  });
  const deck: DeckEntry = { relative: "talk", absolute: path.join(root, "talk"), kind: "folder" };
  return { root, deck, file: (name: string) => path.join(root, "talk", name) };
}
const read = (file: string) => fs.readFile(file, "utf8").catch(() => null);
const change = (journal: DeckJournal, deck: DeckEntry, label: string, run: () => Promise<unknown>) =>
  journal.journaled(deck, () => label, run);

describe("DeckJournal recording", () => {
  it("records only the files a write changed, under its label", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    expect(journal.history(deck)).toEqual({ undo: null, redo: null });
    await change(journal, deck, "Edit slide 1", () =>
      fs.writeFile(file("slides/01.slide.md"), "# Changed\n"),
    );
    expect(journal.history(deck)).toEqual({ undo: "Edit slide 1", redo: null });
    const snapshot = await journal.snapshot(deck);
    expect([...snapshot.keys()].sort()).toEqual(["presentation.yml", "slides/01.slide.md"]);
  });

  it("records nothing when a write changes nothing, and what changed when it fails part-way", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    await change(journal, deck, "No-op", async () => undefined);
    expect(journal.history(deck).undo).toBeNull();
    await expect(
      change(journal, deck, "Half done", async () => {
        await fs.writeFile(file("slides/02.slide.md"), "# Two\n");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(journal.history(deck).undo).toBe("Half done");
    await journal.undo(deck);
    expect(await read(file("slides/02.slide.md"))).toBeNull();
  });

  it("ignores exports and hidden folders", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    await change(journal, deck, "Export", () => fs.writeFile(file("exports/out.png"), "new export"));
    await change(journal, deck, "Cache", () => fs.writeFile(file(".cache/x"), "new"));
    expect(journal.history(deck).undo).toBeNull();
  });

  it("keeps at most 50 steps and drops the oldest", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    for (let n = 1; n <= MAX_STEPS + 1; n += 1)
      await change(journal, deck, `Edit ${n}`, () => fs.writeFile(file("slides/01.slide.md"), `# ${n}\n`));
    let undone = 0;
    while (journal.history(deck).undo) {
      await journal.undo(deck);
      undone += 1;
    }
    expect(undone).toBe(MAX_STEPS);
    expect(await read(file("slides/01.slide.md"))).toBe("# 1\n");
  });

  it("drops the oldest steps past the byte limit, and clears history for a change that is too big", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    // Six new 12 MB files are 72 MB of steps: the 64 MB cap drops the first.
    const big = Buffer.alloc(12 * 1024 * 1024, 1);
    for (const n of [1, 2, 3, 4, 5, 6])
      await change(journal, deck, `Big ${n}`, () => fs.writeFile(file(`big-${n}.bin`), big));
    expect(6 * big.length).toBeGreaterThan(MAX_JOURNAL_BYTES);
    const labels: string[] = [];
    while (journal.history(deck).undo) {
      labels.push(journal.history(deck).undo!);
      await journal.undo(deck);
    }
    expect(labels).toEqual(["Big 6", "Big 5", "Big 4", "Big 3", "Big 2"]);
    expect(await read(file("big-1.bin"))).not.toBeNull();

    // 16 MB files are skipped by the snapshot, so a too-big step is built from several files.
    const chunk = Buffer.alloc(15 * 1024 * 1024, 2);
    await change(journal, deck, "Huge", async () => {
      for (const n of [1, 2, 3, 4, 5]) await fs.writeFile(file(`huge-${n}.bin`), chunk);
    });
    expect(journal.history(deck)).toEqual({ undo: null, redo: null });
  });

  it("a single-file deck covers its file and the shared assets folder", async () => {
    const root = await tempDir();
    await write(root, { "one.slide.md": "# One\n", "other.slide.md": "# Other\n" });
    const deck: DeckEntry = {
      relative: "one.slide.md",
      absolute: path.join(root, "one.slide.md"),
      kind: "single",
    };
    const journal = new DeckJournal();
    await change(journal, deck, "Other deck", () =>
      fs.writeFile(path.join(root, "other.slide.md"), "# Changed\n"),
    );
    expect(journal.history(deck).undo).toBeNull();
    await change(journal, deck, "Upload a.png", async () => {
      await fs.mkdir(path.join(root, "assets"));
      await fs.writeFile(path.join(root, "assets/a.png"), "png");
    });
    expect(journal.history(deck).undo).toBe("Upload a.png");
    await journal.undo(deck);
    expect(await read(path.join(root, "assets/a.png"))).toBeNull();
  });
});

describe("DeckJournal undo and redo", () => {
  it("restores exact bytes, created and deleted files included, and redo reapplies", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    const manifest = await read(file("presentation.yml"));
    await change(journal, deck, "Delete slide 1", async () => {
      await fs.rm(file("slides/01.slide.md"));
      await fs.writeFile(file("presentation.yml"), "title: Talk\nslides: []\n");
    });
    await change(journal, deck, "Add slide", async () => {
      await fs.mkdir(file("new"), { recursive: true });
      await fs.writeFile(file("new/02.slide.md"), "# Two\n");
    });

    await journal.undo(deck);
    expect(await read(file("new/02.slide.md"))).toBeNull();
    expect(await journal.undo(deck)).toEqual({ undo: null, redo: "Delete slide 1" });
    expect(await read(file("slides/01.slide.md"))).toBe("# One\n");
    expect(await read(file("presentation.yml"))).toBe(manifest);

    await journal.redo(deck);
    expect(await read(file("slides/01.slide.md"))).toBeNull();
    await fs.rm(file("new"), { recursive: true });
    expect(await journal.redo(deck)).toEqual({ undo: "Add slide", redo: null });
    expect(await read(file("new/02.slide.md"))).toBe("# Two\n");
  });

  it("a new change clears redo", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    await change(journal, deck, "A", () => fs.writeFile(file("slides/01.slide.md"), "# A\n"));
    await journal.undo(deck);
    expect(journal.history(deck).redo).toBe("A");
    await change(journal, deck, "B", () => fs.writeFile(file("slides/01.slide.md"), "# B\n"));
    expect(journal.history(deck)).toEqual({ undo: "B", redo: null });
    await expect(journal.redo(deck)).rejects.toMatchObject({ status: 409, code: "NOTHING_TO_REDO" });
  });

  it("refuses when a file changed outside Studio and writes nothing", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    await change(journal, deck, "Two files", async () => {
      await fs.writeFile(file("slides/01.slide.md"), "# Studio\n");
      await fs.writeFile(file("presentation.yml"), "title: Studio\nslides:\n  - slides/01.slide.md\n");
    });
    await fs.writeFile(file("slides/01.slide.md"), "# By hand\n");
    await expect(journal.undo(deck)).rejects.toMatchObject({
      status: 409,
      code: "UNDO_CONFLICT",
      details: { files: ["slides/01.slide.md"] },
    });
    expect(await read(file("presentation.yml"))).toBe("title: Studio\nslides:\n  - slides/01.slide.md\n");
    expect(await read(file("slides/01.slide.md"))).toBe("# By hand\n");
    expect(journal.history(deck).undo).toBe("Two files");
  });

  it("says when there is nothing to undo", async () => {
    const { deck } = await folderDeck();
    await expect(new DeckJournal().undo(deck)).rejects.toMatchObject({
      status: 409,
      code: "NOTHING_TO_UNDO",
    });
  });

  it("runs one deck's writes and undos one at a time", async () => {
    const { deck, file } = await folderDeck();
    const journal = new DeckJournal();
    await Promise.all(
      [1, 2, 3].map((n) =>
        change(journal, deck, `Edit ${n}`, async () => {
          const current = (await read(file("slides/01.slide.md")))!;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await fs.writeFile(file("slides/01.slide.md"), `${current}${n}\n`);
        }),
      ),
    );
    expect(await read(file("slides/01.slide.md"))).toBe("# One\n1\n2\n3\n");
    for (const expected of ["# One\n1\n2\n", "# One\n1\n", "# One\n"]) {
      await journal.undo(deck);
      expect(await read(file("slides/01.slide.md"))).toBe(expected);
    }
  });
});
