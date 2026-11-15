import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPresentation } from "@flipbook-md/core";
import { resetContextCache } from "../src/server/ai/budget.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import { TMP_DIR } from "../src/server/workspace.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture, LlmScript } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";
import { PNG, buildDocx, docx } from "./support/docx.js";
import { headers, makeApp, tempDir } from "./helpers.js";

// US-18 · 2.3.1: generate-deck with source: { sourceId } (tech-spec D7, D15, D17, D19).

const DOC = buildDocx({
  body: [
    docx.heading(1, "Índices"),
    docx.para("Por que importam."),
    docx.heading(2, "Tipos"),
    docx.bullet("B-tree"),
    docx.image("rIdImg", "um gráfico"),
  ].join(""),
  images: [{ rel: "rIdImg", file: "chart.png", data: PNG }],
});
const lines = (...slides: object[]): LlmFixture => ({
  kind: "text",
  text: `${slides.map((slide) => JSON.stringify(slide)).join("\n")}\n`,
});
const slide = (markdown: string) => ({ type: null, markdown });

beforeEach(() => resetContextCache());

async function setup(script: LlmScript) {
  const root = await tempDir();
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({
    llm: { baseUrl: "http://127.0.0.1:9/v1", model: "stub-model", maxRepairRounds: 1 },
  });
  const fake = new FakeProvider(script);
  const app = await makeApp(root, [], { settings, llmProvider: () => fake });
  const upload = async (name = "indices.docx", bytes = DOC) => {
    const form = new FormData();
    form.append("file", new File([Buffer.from(bytes)], name));
    const response = await app.request("/api/sources", { method: "POST", headers: headers(), body: form });
    expect(response.status).toBe(201);
    return (await response.json()).source.sourceId as string;
  };
  const generate = (sourceId: string, extra: object = {}, init: RequestInit = {}) =>
    app.request("/api/ai/generate-deck", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "indices",
        title: "Índices",
        kind: "folder",
        group: null,
        source: { sourceId },
        ...extra,
      }),
      ...init,
    });
  const runs = async () =>
    (await fs.readdir(path.join(root, TMP_DIR)).catch(() => [] as string[])).filter(
      (name) => name !== "sources",
    );
  return { root, fake, upload, generate, runs };
}

describe("generate-deck from an uploaded file", () => {
  it("writes the file's images first, keeps their references and removes invented ones", async () => {
    const { root, fake, upload, generate, runs } = await setup({
      chat: [
        lines(
          slide("# Índices\n\nPor que importam."),
          slide("# Tipos\n\n- B-tree\n\n![um gráfico](assets/image1.png)"),
          slide("# Extra\n\n![inventada](assets/invented.png)\n\n![remota](https://x.test/a.png)"),
        ),
      ],
    });
    const sourceId = await upload();
    const list = await sseEvents(await generate(sourceId));
    expect(list.map((item) => item.event)).toEqual(["slide", "slide", "slide", "notice", "done"]);
    expect(list[3]!.data).toEqual({ message: "Removed 1 image reference(s) that weren't in the file" });
    expect(list.at(-1)!.data).toEqual({ deckId: encodeDeckId("indices"), violations: [] });

    const prompt = fake.requests[0]!.messages.at(-1)!.content;
    expect(prompt).toContain("Keep its facts, its order and its language");
    expect(prompt).toContain("![um gráfico](assets/image1.png)");
    expect(prompt).toContain("The source text places these images: assets/image1.png.");
    expect(prompt).toContain("# Índices");

    const files = (name: string) => fs.readdir(path.join(root, "indices", name));
    expect(await files("assets")).toEqual(["image1.png"]);
    const { presentation } = await loadPresentation(path.join(root, "indices"), { blueprint: "evaluate" });
    expect(presentation.slides[1]!.html).toContain("image1.png");
    expect(presentation.slides[2]!.html).not.toContain("invented");
    expect(presentation.slides[2]!.html).toContain("https://x.test/a.png");
    expect(await runs()).toEqual([]);
    // The source is used up.
    expect((await generate(sourceId, { name: "again" })).status).toBe(404);
  });

  it("answers before streaming for an expired source or a single-file deck", async () => {
    const { upload, generate } = await setup({ chat: [lines(slide("# A"))] });
    const expired = await generate("00000000-0000-4000-8000-000000000000");
    expect(expired.status).toBe(404);
    expect((await expired.json()).error.code).toBe("SOURCE_EXPIRED");
    const sourceId = await upload();
    const single = await generate(sourceId, { kind: "single" });
    expect(single.status).toBe(422);
    expect((await single.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("keeps the source language unless one is set", async () => {
    const { fake, upload, generate } = await setup({ chat: [lines(slide("# A"))] });
    await sseEvents(await generate(await upload()));
    expect(fake.requests[0]!.messages.at(-1)!.content).toContain(
      "Write in the same language as the source text.",
    );
  });

  it("removes the temp deck and its images when cancelled", async () => {
    const { root, upload, generate, runs } = await setup({
      chat: [
        {
          kind: "slowTokens",
          ms: 30,
          text: `${JSON.stringify(slide("# A"))}\n${JSON.stringify(slide("# B"))}\n`,
        },
      ],
    });
    const sourceId = await upload();
    const client = new AbortController();
    const response = await generate(sourceId, {}, { signal: client.signal });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    while (!seen.includes("event: slide")) {
      const next = await reader.read();
      if (next.done) throw new Error(`Stream ended early: ${seen}`);
      seen += next.value;
    }
    const [run] = await runs();
    expect(await fs.readdir(path.join(root, TMP_DIR, run!, "indices", "assets"))).toEqual(["image1.png"]);
    client.abort();
    void reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && (await runs()).length; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(await runs()).toEqual([]);
    await expect(fs.access(path.join(root, "indices"))).rejects.toThrow();
  });
});
