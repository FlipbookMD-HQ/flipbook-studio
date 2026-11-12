import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashBytes } from "@flipbook-md/core";
import { PROPOSAL_LIMIT, ProposalStore, applyProposal } from "../src/server/ai/proposals.js";
import { encodeDeckId } from "../src/server/paths.js";
import { ProposalOpSchema, type SlideDraft } from "../src/shared/api.js";
import { FOLDER_DECK, SINGLE_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

const draft = (markdown: string): SlideDraft => ({
  markdown,
  template: null,
  type: null,
  notes: "",
  title: null,
  directives: {},
});

async function folderWorkspace() {
  const root = await tempDir();
  await write(
    root,
    Object.fromEntries(Object.entries(FOLDER_DECK).map(([name, body]) => [`deck/${name}`, body])),
  );
  const hash = async (file: string) => hashBytes(await fs.readFile(path.join(root, "deck", file)));
  return {
    root,
    deckId: encodeDeckId("deck"),
    hash,
    read: (file: string) => fs.readFile(path.join(root, "deck", file), "utf8"),
  };
}

describe("ProposalStore", () => {
  it("keeps the newest 100 and forgets older ones", () => {
    const store = new ProposalStore();
    const first = store.add({ deckId: null, summary: "first", ops: [], baseHashes: {} });
    for (let index = 0; index < PROPOSAL_LIMIT; index += 1)
      store.add({ deckId: null, summary: `p${index}`, ops: [], baseHashes: {} });
    expect(store.size).toBe(PROPOSAL_LIMIT);
    expect(() => store.get(first.id)).toThrow(expect.objectContaining({ code: "PROPOSAL_NOT_FOUND" }));
  });

  it("refuses path-like slide IDs in every op kind", () => {
    for (const slideId of ["../outside.slide.md", "/etc/passwd", "a\\b", "C:/x"]) {
      expect(ProposalOpSchema.safeParse({ id: "o", kind: "deleteSlide", slideId }).success).toBe(false);
      expect(
        ProposalOpSchema.safeParse({ id: "o", kind: "updateSlide", slideId, draft: draft("x") }).success,
      ).toBe(false);
    }
    expect(
      ProposalOpSchema.safeParse({ id: "o", kind: "deleteSlide", slideId: "slides/01.slide.md" }).success,
    ).toBe(true);
    expect(ProposalOpSchema.safeParse({ id: "o", kind: "deleteSlide", slideId: "#2" }).success).toBe(true);
  });
});

describe("applyProposal", () => {
  it("applies every op in a safe order and returns the new hashes", async () => {
    const { root, deckId, hash, read } = await folderWorkspace();
    const store = new ProposalStore();
    const proposal = store.add({
      deckId,
      summary: "edit",
      ops: [
        { id: "del", kind: "deleteSlide", slideId: "slides/02.slide.md" },
        { id: "add", kind: "addSlide", afterSlideId: "slides/01.slide.md", draft: draft("# Added") },
        { id: "upd", kind: "updateSlide", slideId: "slides/01.slide.md", draft: draft("# First, rewritten") },
      ],
      baseHashes: {
        "slides/01.slide.md": await hash("slides/01.slide.md"),
        "presentation.yml": await hash("presentation.yml"),
      },
    });
    const result = await applyProposal(root, store, proposal.id, ["del", "add", "upd"]);
    expect(result.rejected).toEqual([]);
    expect(result.applied).toEqual(["upd", "add", "del"]);
    expect(await read("slides/01.slide.md")).toContain("First, rewritten");
    const manifest = await read("presentation.yml");
    expect(manifest).not.toContain("02.slide.md");
    expect(result.hashes["presentation.yml"]).toBe(await hash("presentation.yml"));
  });

  it("applies only the chosen ops, and rejects them all as stale the second time", async () => {
    const { root, deckId, hash, read } = await folderWorkspace();
    const store = new ProposalStore();
    const proposal = store.add({
      deckId,
      summary: "two",
      ops: [
        { id: "a", kind: "updateSlide", slideId: "slides/01.slide.md", draft: draft("# A") },
        { id: "b", kind: "updateSlide", slideId: "slides/02.slide.md", draft: draft("# B") },
      ],
      baseHashes: {
        "slides/01.slide.md": await hash("slides/01.slide.md"),
        "slides/02.slide.md": await hash("slides/02.slide.md"),
      },
    });
    expect((await applyProposal(root, store, proposal.id, ["b"])).applied).toEqual(["b"]);
    expect(await read("slides/01.slide.md")).toContain("# First");
    expect(await read("slides/02.slide.md")).toContain("# B");
    const again = await applyProposal(root, store, proposal.id, ["b"]);
    expect(again.applied).toEqual([]);
    expect(again.rejected).toEqual([expect.objectContaining({ opId: "b", code: "STALE_PROPOSAL" })]);
  });

  it("rejects one stale op without blocking the valid ones", async () => {
    const { root, deckId, hash, read } = await folderWorkspace();
    const store = new ProposalStore();
    const proposal = store.add({
      deckId,
      summary: "two",
      ops: [
        { id: "a", kind: "updateSlide", slideId: "slides/01.slide.md", draft: draft("# A") },
        { id: "b", kind: "updateSlide", slideId: "slides/02.slide.md", draft: draft("# B") },
      ],
      baseHashes: {
        "slides/01.slide.md": await hash("slides/01.slide.md"),
        "slides/02.slide.md": await hash("slides/02.slide.md"),
      },
    });
    await fs.writeFile(path.join(root, "deck/slides/01.slide.md"), "# Edited on disk\n");
    const result = await applyProposal(root, store, proposal.id, ["a", "b"]);
    expect(result.applied).toEqual(["b"]);
    expect(result.rejected).toEqual([expect.objectContaining({ opId: "a", code: "STALE_PROPOSAL" })]);
    expect(await read("slides/01.slide.md")).toBe("# Edited on disk\n");
  });

  it("rejects a hostile path-like slide ID as VALIDATION_FAILED and writes nothing outside", async () => {
    const { root, deckId, hash } = await folderWorkspace();
    const store = new ProposalStore();
    const proposal = store.add({
      deckId,
      summary: "hostile",
      ops: [{ id: "h", kind: "updateSlide", slideId: "../../outside.slide.md", draft: draft("# pwned") }],
      baseHashes: { "../../outside.slide.md": await hash("slides/01.slide.md") },
    });
    const result = await applyProposal(root, store, proposal.id, ["h"]);
    expect(result.rejected).toEqual([expect.objectContaining({ opId: "h", code: "VALIDATION_FAILED" })]);
    await expect(fs.access(path.join(root, "..", "outside.slide.md"))).rejects.toThrow();
  });

  it("moves a slide in a single-file deck", async () => {
    const root = await tempDir();
    await write(root, { "talk.slide.md": SINGLE_DECK });
    const store = new ProposalStore();
    const proposal = store.add({
      deckId: encodeDeckId("talk.slide.md"),
      summary: "move",
      ops: [{ id: "m", kind: "moveSlide", slideId: "#1", toIndex: 0 }],
      baseHashes: { "talk.slide.md": hashBytes(await fs.readFile(path.join(root, "talk.slide.md"))) },
    });
    expect((await applyProposal(root, store, proposal.id, ["m"])).applied).toEqual(["m"]);
    const text = await fs.readFile(path.join(root, "talk.slide.md"), "utf8");
    expect(text.indexOf("# Two")).toBeLessThan(text.indexOf("# One"));
  });
});

describe("proposal routes", () => {
  it("returns 404 PROPOSAL_NOT_FOUND for an unknown proposal, and DELETE forgets one", async () => {
    const app = await makeApp(await tempDir());
    const json = headers({ "content-type": "application/json" });
    const apply = await app.request("/api/proposals/nope/apply", {
      method: "POST",
      headers: json,
      body: '{"opIds":[]}',
    });
    expect(apply.status).toBe(404);
    expect((await apply.json()).error.code).toBe("PROPOSAL_NOT_FOUND");
    expect((await app.request("/api/proposals/nope", { method: "DELETE", headers: headers() })).status).toBe(
      404,
    );
  });
});
