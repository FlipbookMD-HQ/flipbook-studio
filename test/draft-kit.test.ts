import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KIT_FILE_LIMIT, kitDraftToSources, readKitReply } from "../src/server/ai/draft-kit.js";
import { draftKitMessages, type DraftKitContext } from "../src/server/ai/prompts/draft-kit.js";
import { resetContextCache } from "../src/server/ai/budget.js";
import { OutputProblem } from "../src/server/ai/structured.js";
import { resetResponseFormatMemory } from "../src/server/llm/provider.js";
import { encodeDeckId } from "../src/server/paths.js";
import { SettingsStore } from "../src/server/settings.js";
import type { KitKind } from "../src/shared/api.js";
import { FakeProvider } from "./support/fake-provider.js";
import type { LlmFixture } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";
import { FOLDER_DECK, headers, makeApp, tempDir, write } from "./helpers.js";

const CSS = `:host {
  --slide-bg: #101820;
  --slide-text: #f2f2f2;
  --slide-muted: #a0a8b0;
  --slide-accent: #ffb000;
  --slide-mint: #6fe3c1;
  --slide-heading: #ffffff;
  --slide-line: #2a3440;
  --slide-code: #0b1116;
  font-family: Inter, system-ui, sans-serif;
}
h1 { letter-spacing: -.03em; }`;
const PLACEMENT = { column: 1, row: 1, width: 3, height: 1, align: "start", role: "content" };
const BLUEPRINT = {
  types: { cover: { require: ["heading"], max_chars: 200 }, point: { template: "flow", max_items: 4 } },
  pages: [{ type: "cover" }, { type: "point", repeat: { min: 1, max: 6 } }],
};
const group = (extra: Record<string, unknown> = {}) => ({
  description: "Quarterly report decks.",
  canvas: "midnight",
  themes: ["marvel-jarvis"],
  style: "marvel-jarvis",
  templates: {
    cover: { column: 1, row: 1, width: 3, height: 3, align: "center", role: "cover", layout: "poster" },
    report_body: { column: 1, row: 1, width: 3, height: 3, align: "start", role: "content" },
  },
  blueprint: {
    types: { cover: { template: "cover", require: ["heading"] }, body: { template: "report_body" } },
    pages: [{ type: "cover" }, { type: "body", repeat: { min: 1, max: 8 } }],
  },
  ...extra,
});
const knowledge = () => ({
  themes: new Set(["marvel-jarvis", "marvel-ultron"]),
  templates: new Set<string>(),
});

describe("draft-kit prompts", () => {
  const context = (kind: KitKind): DraftKitContext => ({
    kind,
    name: kind === "theme" ? "sunset" : "report",
    description: "Warm, calm colours for quarterly reports.",
    referenceCss: ":host { --slide-bg: #000; }",
    themes: ["marvel-jarvis", "marvel-ultron"],
    templates: ["flow", "cover", "summary", "wide"],
  });
  for (const kind of ["theme", "template", "blueprint", "group"] as const) {
    it(`builds the ${kind} prompt`, () => {
      expect(draftKitMessages(context(kind))).toMatchSnapshot();
    });
  }
});

describe("kitDraftToSources", () => {
  it("accepts a theme with every token, as given", () => {
    const result = kitDraftToSources("theme", "sunset", { css: CSS }, knowledge());
    expect(result).toEqual({
      files: [{ kind: "theme", name: "sunset", source: `${CSS}\n` }],
      themesToDraft: [],
    });
  });

  it("serializes a template placement to YAML", () => {
    const result = kitDraftToSources("template", "wide", { ...PLACEMENT, extra: "dropped" }, knowledge());
    expect(result.files[0]!.source).toBe(
      "column: 1\nrow: 1\nwidth: 3\nheight: 1\nalign: start\nrole: content\n",
    );
  });

  it("serializes a blueprint, pages first", () => {
    const { files } = kitDraftToSources("blueprint", "pitch", BLUEPRINT, knowledge());
    expect(files[0]!.source).toMatchSnapshot();
  });

  it("forces group template names to <group>_ and follows them in the blueprint", () => {
    const { files, themesToDraft } = kitDraftToSources("group", "report", group(), knowledge());
    expect(themesToDraft).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]!.source).toMatchSnapshot();
    expect(files[0]!.source).toContain("report_cover:");
    expect(files[0]!.source).toContain("template: report_cover");
    expect(files[0]!.source).toContain("template: report_body");
  });

  it("rejects a group that references a theme that neither exists nor is drafted", () => {
    expect(() =>
      kitDraftToSources("group", "report", group({ themes: ["nope"], style: "nope" }), knowledge()),
    ).toThrow(/Theme "nope" doesn't exist/);
  });

  it("returns a theme to draft when the group drafts one", () => {
    const result = kitDraftToSources(
      "group",
      "report",
      group({ themes: ["marvel-jarvis", { name: "report-warm", draft: "Warm sand" }], style: "report-warm" }),
      knowledge(),
    );
    expect(result.themesToDraft).toEqual([{ name: "report-warm", description: "Warm sand" }]);
    expect(result.files[0]!.source).toContain("style: report-warm");
  });

  it("rejects a drafted theme whose name exists, and a style outside the themes", () => {
    expect(() =>
      kitDraftToSources(
        "group",
        "report",
        group({ themes: [{ name: "marvel-jarvis", draft: "x" }] }),
        knowledge(),
      ),
    ).toThrow(/already exists/);
    expect(() =>
      kitDraftToSources("group", "report", group({ style: "marvel-ultron" }), knowledge()),
    ).toThrow(/style must be one of its themes/);
  });

  it("rejects an out-of-bounds template and a reserved template name", () => {
    expect(() =>
      kitDraftToSources("template", "wide", { ...PLACEMENT, column: 3, width: 2 }, knowledge()),
    ).toThrow(/leaves the 3x3 grid/);
    expect(() => kitDraftToSources("template", "flow", PLACEMENT, knowledge())).toThrow(
      /not a valid template name/,
    );
  });

  it("rejects a blueprint using an unknown template or type", () => {
    expect(() =>
      kitDraftToSources(
        "blueprint",
        "pitch",
        { ...BLUEPRINT, types: { ...BLUEPRINT.types, cover: { template: "ghost" } } },
        knowledge(),
      ),
    ).toThrow(/unknown template "ghost"/);
    expect(() =>
      kitDraftToSources("blueprint", "pitch", { ...BLUEPRINT, pages: [{ type: "nope" }] }, knowledge()),
    ).toThrow(/unknown type "nope"/);
  });

  it("rejects a theme that misses tokens, doesn't parse, or loads remote CSS", () => {
    expect(() =>
      kitDraftToSources("theme", "t", { css: ":host { --slide-bg: #000; }" }, knowledge()),
    ).toThrow(/must set --slide-text/);
    expect(() => kitDraftToSources("theme", "t", { css: `${CSS}\nh2 {` }, knowledge())).toThrow(
      /doesn't parse: A \{ is not closed/,
    );
    expect(() =>
      kitDraftToSources("theme", "t", { css: `@import url(https://evil.test/x.css);\n${CSS}` }, knowledge()),
    ).toThrow(/@import/);
    expect(() =>
      kitDraftToSources(
        "theme",
        "t",
        { css: `${CSS}\nh1 { background: url(https://evil.test/a.png); }` },
        knowledge(),
      ),
    ).toThrow(/Remote url/);
  });

  it("caps each drafted file at 50 kB", () => {
    const huge = `${CSS}\n/* ${"x".repeat(KIT_FILE_LIMIT)} */`;
    expect(() => kitDraftToSources("theme", "t", { css: huge }, knowledge())).toThrow(/over 50 kB/);
    expect(() =>
      kitDraftToSources("group", "report", group({ description: "d", huge: "x" }), knowledge()),
    ).not.toThrow();
    const many = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [`t${index}`, { template: "flow", max_chars: index }]),
    );
    expect(() =>
      kitDraftToSources("blueprint", "pitch", { types: many, pages: [{ type: "t0" }] }, knowledge()),
    ).toThrow(/over 50 kB/);
  });

  it("is synchronous and reads nothing from disk", async () => {
    const home = process.env.FLIPBOOK_HOME;
    process.env.FLIPBOOK_HOME = path.join(await tempDir(), "missing");
    try {
      const result = kitDraftToSources("group", "report", group(), knowledge());
      expect(result).not.toBeInstanceOf(Promise);
      await expect(fs.stat(process.env.FLIPBOOK_HOME)).rejects.toThrow();
    } finally {
      process.env.FLIPBOOK_HOME = home;
    }
  });
});

describe("readKitReply", () => {
  it("reads JSON, and YAML without anchors", () => {
    expect(readKitReply('{"column": 1}')).toEqual({ column: 1 });
    expect(readKitReply("column: 1\nalign: start\n")).toEqual({ column: 1, align: "start" });
  });

  it("rejects anchors, aliases, invalid YAML and huge replies", () => {
    expect(() => readKitReply("a: &x { b: 1 }\nc: *x\n")).toThrow(OutputProblem);
    expect(() => readKitReply("a: &x 1\n")).toThrow(/anchors and aliases/);
    expect(() => readKitReply("a: [1, 2\n")).toThrow(/wasn't valid JSON or YAML \(Flow sequence/);
    expect(() => readKitReply(`a: "${"x".repeat(KIT_FILE_LIMIT)}"`)).toThrow(/over 50 kB/);
    // The billion laughs shape never expands.
    const laughs = [
      'a: &a ["lol","lol"]',
      "b: &b [*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b]",
      "d: [*c,*c,*c,*c]",
    ].join("\n");
    expect(() => readKitReply(laughs)).toThrow(/anchors and aliases/);
  });
});

// ---------------------------------------------------------------- route

let home: string | undefined;
beforeEach(() => {
  resetContextCache();
  resetResponseFormatMemory();
  home = process.env.FLIPBOOK_HOME;
});
afterEach(() => {
  process.env.FLIPBOOK_HOME = home;
});

async function listAll(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.map(String).sort();
}

async function setup(chat: LlmFixture[] | ((request: { messages: { content: string }[] }) => LlmFixture)) {
  const root = await tempDir();
  await write(
    root,
    Object.fromEntries(Object.entries(FOLDER_DECK).map(([file, body]) => [`deck/${file}`, body])),
  );
  const library = await tempDir("studio-draft-lib-");
  process.env.FLIPBOOK_HOME = library;
  await write(library, {
    "themes/house.css": CSS,
    "templates/taken.yml": "column: 1\nrow: 1\nwidth: 1\nheight: 1\nalign: start\n",
  });
  const settings = await SettingsStore.open(await tempDir(), () => {});
  await settings.update({ llm: { baseUrl: "http://127.0.0.1:9/v1", model: "stub-model" } });
  const fake = new FakeProvider({ chat: chat as never });
  const app = await makeApp(root, [], { settings, library, llmProvider: () => fake });
  const request = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const snapshot = async () => ({ root: await listAll(root), library: await listAll(library) });
  return { root, library, app, fake, request, snapshot };
}

describe("POST /api/ai/draft-kit", () => {
  const cases: [KitKind, string, unknown, string][] = [
    ["theme", "sunset", { css: CSS }, "themes/sunset.css"],
    ["template", "wide", PLACEMENT, "templates/wide.yml"],
    ["blueprint", "pitch", BLUEPRINT, "blueprints/pitch.yml"],
    ["group", "report", group(), "templates/report.yml"],
  ];
  for (const [kind, name, value, file] of cases) {
    it(`drafts a ${kind} as a proposal, writing nothing until it is applied`, async () => {
      const { request, snapshot, library } = await setup([{ kind: "json", value }]);
      const before = await snapshot();
      const events = await sseEvents(
        await request("/api/ai/draft-kit", { kind, name, description: "Something calm." }),
      );
      expect(events.map((event) => event.event).filter((event) => event !== "token")).toEqual([
        "proposal",
        "done",
      ]);
      expect(events.some((event) => event.event === "token")).toBe(true);
      const proposal = events.find((event) => event.event === "proposal")!.data;
      expect(proposal.ops).toHaveLength(1);
      expect(proposal.ops[0]).toMatchObject({
        id: "op-1",
        kind: "writeKitFile",
        kit: { kind, name, scope: "library" },
      });
      expect(await snapshot()).toEqual(before);

      const applied = await request(`/api/proposals/${proposal.id}/apply`, { opIds: ["op-1"] });
      expect((await applied.json()).applied).toEqual(["op-1"]);
      expect(await fs.readFile(path.join(library, file), "utf8")).toBe(proposal.ops[0].source);
    });
  }

  it("drafts a group with a new theme as two ops; applying writes both", async () => {
    const { request, library, fake } = await setup([
      {
        kind: "json",
        value: group({ themes: [{ name: "report-warm", draft: "Warm sand" }], style: "report-warm" }),
      },
      { kind: "json", value: { css: CSS } },
    ]);
    const events = await sseEvents(
      await request("/api/ai/draft-kit", { kind: "group", name: "report", description: "Warm reports." }),
    );
    expect(events.find((event) => event.event === "notice")?.data).toEqual({
      message: "Drafting theme report-warm",
    });
    const proposal = events.find((event) => event.event === "proposal")!.data;
    expect(
      proposal.ops.map((op: { kit: { kind: string; name: string } }) => `${op.kit.kind}:${op.kit.name}`),
    ).toEqual(["group:report", "theme:report-warm"]);
    expect(fake.requests[1]!.messages[1]!.content).toContain("Warm sand");
    const applied = await (
      await request(`/api/proposals/${proposal.id}/apply`, { opIds: ["op-1", "op-2"] })
    ).json();
    expect(applied).toMatchObject({ applied: ["op-1", "op-2"], rejected: [] });
    expect(await fs.readFile(path.join(library, "themes/report-warm.css"), "utf8")).toBe(`${CSS}\n`);
    expect(await fs.readFile(path.join(library, "templates/report.yml"), "utf8")).toContain(
      "style: report-warm",
    );
  });

  it("feeds a validation problem back once, then succeeds", async () => {
    const { request, fake } = await setup([
      { kind: "json", value: { ...PLACEMENT, width: 9 } },
      { kind: "json", value: PLACEMENT },
    ]);
    const events = await sseEvents(
      await request("/api/ai/draft-kit", { kind: "template", name: "wide", description: "A wide band." }),
    );
    expect(events.at(-1)!.event).toBe("done");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.messages.at(-1)!.content).toMatch(
      /The draft isn't valid: .*leaves the 3x3 grid/,
    );
  });

  it("fails with LLM_BAD_OUTPUT after the retry, and writes nothing", async () => {
    const { request, snapshot } = await setup([
      { kind: "text", text: "a: &x 1\nb: *x" },
      { kind: "json", value: { css: ":host {" } },
    ]);
    const before = await snapshot();
    const events = await sseEvents(
      await request("/api/ai/draft-kit", { kind: "theme", name: "broken", description: "Anything." }),
    );
    const failed = events.at(-1)!;
    expect(failed.event).toBe("failed");
    expect(failed.data.error.code).toBe("LLM_BAD_OUTPUT");
    expect(failed.data.error.message).toMatch(/doesn't parse/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a taken name with KIT_EXISTS before streaming", async () => {
    const { request, fake } = await setup([{ kind: "json", value: { css: CSS } }]);
    for (const [kind, name] of [
      ["theme", "house"],
      ["template", "taken"],
      ["group", "taken"],
    ]) {
      const response = await request("/api/ai/draft-kit", { kind, name, description: "x" });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("KIT_EXISTS");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a reserved or invalid name before streaming", async () => {
    const { request } = await setup([{ kind: "json", value: PLACEMENT }]);
    const reserved = await request("/api/ai/draft-kit", { kind: "template", name: "flow", description: "x" });
    expect(reserved.status).toBe(422);
    expect((await reserved.json()).error.code).toBe("RESERVED_NAME");
    const invalid = await request("/api/ai/draft-kit", { kind: "theme", name: "Bad Name", description: "x" });
    expect(invalid.status).toBe(422);
  });

  it("drafts a deck's own blueprint.yml with the deck's templates", async () => {
    const { request, root } = await setup([{ kind: "json", value: BLUEPRINT }]);
    const deckId = encodeDeckId("deck");
    const events = await sseEvents(
      await request("/api/ai/draft-kit", { kind: "blueprint", name: "blueprint", description: "x", deckId }),
    );
    const proposal = events.find((event) => event.event === "proposal")!.data;
    expect(proposal.ops[0].kit).toEqual({ kind: "blueprint", name: "blueprint", scope: "deck", deckId });
    expect(proposal.deckId).toBe(deckId);
    await request(`/api/proposals/${proposal.id}/apply`, { opIds: ["op-1"] });
    expect(await fs.readFile(path.join(root, "deck/blueprint.yml"), "utf8")).toBe(proposal.ops[0].source);
  });

  it("answers 409 LLM_NOT_CONFIGURED without a model", async () => {
    const root = await tempDir();
    const settings = await SettingsStore.open(await tempDir(), () => {});
    const app = await makeApp(root, [], { settings });
    const response = await app.request("/api/ai/draft-kit", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "theme", name: "x", description: "y" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LLM_NOT_CONFIGURED");
  });
});
