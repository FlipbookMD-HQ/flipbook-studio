import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import type { DeckDetail } from "../src/shared/api.js";
import { FakeProvider } from "./support/fake-provider.js";
import { sseEvents } from "./support/sse.js";
import { FOLDER_DECK, SINGLE_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

// US-17: undo and redo through the API, byte-for-byte on disk.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]),
]);

async function setup() {
  const root = await tempDir();
  await write(root, {
    ...Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`talk/${name}`, body])),
    "one.slide.md": SINGLE_DECK,
  });
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({ llm: { baseUrl: "http://127.0.0.1:9/v1", model: "stub-model" } });
  const fake = new FakeProvider({ chat: [{ kind: "json", value: { markdown: "# Rewritten\n\nShorter." } }] });
  const app = await makeApp(root, [], { settings, llmProvider: () => fake });
  const deckId = encodeDeckId("talk");
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await app.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const detail = async (id = deckId) => (await call("GET", `/api/decks/${id}`)).json as DeckDetail;
  const history = async (id = deckId) => (await call("GET", `/api/decks/${id}/history`)).json;
  const undo = (id = deckId) => call("POST", `/api/decks/${id}/undo`);
  const redo = (id = deckId) => call("POST", `/api/decks/${id}/redo`);
  /** Every file in the deck folder with its bytes. */
  const files = async (dir = path.join(root, "talk")) => {
    const names = (await fs.readdir(dir, { recursive: true })).map(String).sort();
    const out: Record<string, string> = {};
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name));
      if (stat.isFile()) out[name] = (await fs.readFile(path.join(dir, name))).toString("base64");
    }
    return out;
  };
  return { root, app, deckId, call, detail, history, undo, redo, files };
}

describe("undo and redo routes", () => {
  it("undoes and redoes a slide save byte-for-byte", async () => {
    const { deckId, call, detail, history, undo, redo, files } = await setup();
    const before = await files();
    const deck = await detail();
    const slide = deck.slides[1]!;
    const saved = await call("PUT", `/api/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`, {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, markdown: "# Second\n\nChanged." },
    });
    expect(saved.status).toBe(200);
    expect(await history()).toEqual({ undo: "Edit slide 2", redo: null });
    const after = await files();

    const undone = await undo();
    expect(undone.status).toBe(200);
    expect(undone.json.history).toEqual({ undo: null, redo: "Edit slide 2" });
    expect(undone.json.slides[1].draft.markdown).toBe("# Second\n\nText.");
    expect(await files()).toEqual(before);

    expect((await redo()).json.history).toEqual({ undo: "Edit slide 2", redo: null });
    expect(await files()).toEqual(after);
  });

  it("undoes adding, deleting and reordering slides, in order", async () => {
    const { deckId, call, detail, history, undo, files } = await setup();
    const start = await files();
    let deck = await detail();
    const manifest = () => deck.hashes["presentation.yml"];

    await call("POST", `/api/decks/${deckId}/slides`, {
      baseHash: manifest(),
      afterSlideId: deck.slides[1]!.id,
      draft: { ...deck.slides[1]!.draft, markdown: "# Third\n" },
    });
    expect((await history()).undo).toBe("Add slide 3");
    const added = await files();

    deck = await detail();
    await call("PUT", `/api/decks/${deckId}/order`, {
      baseHash: manifest(),
      slideIds: [deck.slides[2]!.id, deck.slides[0]!.id, deck.slides[1]!.id],
    });
    expect((await history()).undo).toBe("Reorder slides");
    const reordered = await files();

    deck = await detail();
    await call(
      "DELETE",
      `/api/decks/${deckId}/slides/${encodeURIComponent(deck.slides[0]!.id)}?baseHash=${manifest()}`,
    );
    expect((await history()).undo).toBe("Delete slide 1");

    await undo();
    expect(await files()).toEqual(reordered);
    await undo();
    expect(await files()).toEqual(added);
    await undo();
    expect(await files()).toEqual(start);
    expect(await history()).toEqual({ undo: null, redo: "Add slide 3" });
  });

  it("undoes an image upload and an image delete", async () => {
    const { app, deckId, history, undo, redo, files } = await setup();
    const start = await files();
    const form = new FormData();
    form.append("file", new File([PNG], "Photo.png"));
    expect(
      (await app.request(`/api/decks/${deckId}/assets`, { method: "POST", headers: headers(), body: form }))
        .status,
    ).toBe(201);
    expect((await history()).undo).toBe("Upload photo.png");
    await undo();
    expect(await files()).toEqual(start);
    await redo();

    const removed = await app.request(`/api/decks/${deckId}/assets/logo.svg?force=1`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(removed.status).toBe(204);
    expect((await history()).undo).toBe("Delete image logo.svg");
    const withPhoto = { ...start };
    await undo();
    const restored = await files();
    expect(restored["assets/logo.svg"]).toBe(start["assets/logo.svg"]);
    expect(Object.keys(restored).filter((name) => !(name in withPhoto))).toEqual(["assets/photo.png"]);
  });

  it("undoes an accepted AI proposal as one step", async () => {
    const { app, deckId, detail, history, undo, call, files } = await setup();
    const start = await files();
    const deck = await detail();
    const slide = deck.slides[0]!;
    const events = await sseEvents(
      await app.request("/api/ai/rewrite", {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          deckId,
          slideId: slide.id,
          baseHash: deck.hashes[slide.file],
          instruction: { kind: "shorten" },
        }),
      }),
    );
    const proposal = events.find((event) => event.event === "proposal")!.data;
    const applied = await call("POST", `/api/proposals/${proposal.id}/apply`, { opIds: ["op-1"] });
    expect(applied.status).toBe(200);
    expect((await history()).undo).toBe(`AI: ${proposal.summary}`);
    expect((await files())["slides/01.slide.md"]).not.toBe(start["slides/01.slide.md"]);
    await undo();
    expect(await files()).toEqual(start);
  });

  it("refuses to undo over an outside edit and writes nothing", async () => {
    const { root, deckId, call, detail, undo, history } = await setup();
    const deck = await detail();
    const slide = deck.slides[1]!;
    await call("PUT", `/api/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`, {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, markdown: "# Second\n\nStudio." },
    });
    await fs.writeFile(path.join(root, "talk/slides/02.slide.md"), "# By hand\n");
    const refused = await undo();
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({
      code: "UNDO_CONFLICT",
      details: { files: ["slides/02.slide.md"] },
    });
    expect(refused.json.error.message).toContain("slides/02.slide.md changed outside Studio");
    expect(await fs.readFile(path.join(root, "talk/slides/02.slide.md"), "utf8")).toBe("# By hand\n");
    expect((await history()).undo).toBe("Edit slide 2");
  });

  it("answers 409 with nothing to undo or redo, 404 for an unknown deck, and keeps decks apart", async () => {
    const { undo, redo, history, call, detail, deckId } = await setup();
    expect((await undo()).json.error.code).toBe("NOTHING_TO_UNDO");
    expect((await redo()).json.error.code).toBe("NOTHING_TO_REDO");
    expect((await call("GET", `/api/decks/${encodeDeckId("nope")}/history`)).status).toBe(404);

    const single = encodeDeckId("one.slide.md");
    const deck = await detail(single);
    await call("PUT", `/api/decks/${single}/slides/${encodeURIComponent("#0")}`, {
      baseHash: deck.hashes[deck.slides[0]!.file],
      draft: { ...deck.slides[0]!.draft, markdown: "# One\n\nChanged." },
    });
    expect(await history(single)).toEqual({ undo: "Edit slide 1", redo: null });
    expect(await history(deckId)).toEqual({ undo: null, redo: null });
  });

  it("does not journal a refused write", async () => {
    const { deckId, call, detail, history } = await setup();
    const deck = await detail();
    const slide = deck.slides[1]!;
    const stale = await call("PUT", `/api/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`, {
      baseHash: "0".repeat(64),
      draft: { ...slide.draft, markdown: "# Nope\n" },
    });
    expect(stale.status).toBe(409);
    expect(await history()).toEqual({ undo: null, redo: null });
  });
});

describe("undo into files that don't load", () => {
  it("applies the undo, answers 200 with loadError, and keeps redo and undo working", async () => {
    const { root, deckId, call, detail, history, undo, redo } = await setup();
    const deck = await detail();
    const slide = deck.slides[0]!;
    const saved = await call("PUT", `/api/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`, {
      baseHash: deck.hashes[slide.file],
      draft: { ...slide.draft, markdown: "# First\n\nChanged." },
    });
    expect(saved.status).toBe(200);
    // presentation.yml breaks outside Studio; it isn't part of the saved step, so undo still runs.
    await fs.writeFile(path.join(root, "talk/presentation.yml"), "title: [unclosed\n");

    const undone = await undo();
    expect(undone.status).toBe(200);
    expect(undone.json.loadError.code).toBe("DECK_LOAD_FAILED");
    expect(undone.json).toMatchObject({ slides: [], hashes: {}, violations: [] });
    expect(undone.json.history).toEqual({ undo: null, redo: "Edit slide 1" });
    expect(await history()).toEqual({ undo: null, redo: "Edit slide 1" });
    // The undo really happened: the slide file is back to its original bytes.
    expect(await fs.readFile(path.join(root, "talk", slide.file), "utf8")).toBe(
      FOLDER_DECK[slide.file as keyof typeof FOLDER_DECK],
    );

    const redone = await redo();
    expect(redone.status).toBe(200);
    expect(redone.json.loadError.code).toBe("DECK_LOAD_FAILED");
    expect(await fs.readFile(path.join(root, "talk", slide.file), "utf8")).toContain("Changed.");

    // Fixing the file makes the deck load again, and responses carry no loadError.
    await fs.writeFile(path.join(root, "talk/presentation.yml"), FOLDER_DECK["presentation.yml"]!);
    const again = await undo();
    expect(again.status).toBe(200);
    expect(again.json.loadError ?? null).toBeNull();
    expect(again.json.slides.length).toBe(2);
  });
});
