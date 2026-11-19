import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { HistoryState, Version } from "../src/shared/api.js";
import { DirtyDialog, RestoreConfirm, Timeline, discardDeletes } from "../src/ui/screens/HistoryPanel.js";
import { UndoControls, historyKey } from "../src/ui/screens/UndoControls.js";
import { isDeckWrite } from "../src/ui/undo.js";

// US-26 · 1.2.1: Restore deck in the History panel, rendered to static markup (no DOM needed).

const html = (element: ReactElement) => renderToStaticMarkup(element);
const text = (element: ReactElement) =>
  html(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([?.,:;])/g, "$1")
    .trim();

const version = (note: string, sha = "a".repeat(40)): Version => ({
  sha,
  note,
  author: "Ada",
  time: "2026-11-19T10:00:00.000Z",
  slidesChanged: 1,
});
const state = (extra: Partial<HistoryState>): HistoryState => ({
  state: "ready",
  reason: null,
  repoRoot: "/home/ada/decks",
  canInit: { deck: false, workspace: false },
  head: version("v2", "b".repeat(40)),
  dirty: true,
  changes: [],
  detached: false,
  ...extra,
});
const noop = () => {};

describe("Restore deck on the timeline", () => {
  it("each entry has Restore deck", () => {
    const markup = html(
      createElement(Timeline, {
        versions: [version("v2", "b".repeat(40)), version("v1")],
        hasMore: false,
        onLoadMore: noop,
        onRestore: noop,
      }),
    );
    expect(markup.match(/>Restore deck</g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Restore deck to v1"');
    expect(markup).not.toMatch(/disabled=""/);
  });

  it("is disabled with 'Save or discard your edits first' while the slide has unsaved edits", () => {
    const markup = html(
      createElement(Timeline, {
        versions: [version("v1")],
        hasMore: false,
        onLoadMore: noop,
        onRestore: noop,
        restoreBlocked: "Save or discard your edits first",
      }),
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*title="Save or discard your edits first"[^>]*>Restore deck/,
    );
  });

  it("isn't shown without a restore handler (US-23 timeline unchanged)", () => {
    const markup = html(
      createElement(Timeline, { versions: [version("v1")], hasMore: false, onLoadMore: noop }),
    );
    expect(markup).not.toContain("Restore deck");
  });
});

describe("the confirmation", () => {
  it("names the version and says no commit is made and it can be undone", () => {
    const shown = text(
      createElement(RestoreConfirm, { version: version("first draft"), onConfirm: noop, onCancel: noop }),
    );
    expect(shown).toContain("Restore the whole deck to “first draft”?");
    expect(shown).toContain("No commit is made and no version is deleted; you can undo it.");
    expect(shown).toMatch(/Restore Cancel$/);
  });
});

describe("the dirty-deck dialog", () => {
  const changes: HistoryState["changes"] = [
    { path: "notes.md", status: "added" },
    { path: "slides/01.slide.md", status: "modified" },
    { path: "slides/02.slide.md", status: "deleted" },
    { path: "assets/new image.png", status: "added" },
  ];

  it("offers Save version first, Discard my changes and Cancel", () => {
    const markup = html(
      createElement(DirtyDialog, {
        version: version("v1"),
        history: state({ changes }),
        onSave: noop,
        onDiscard: noop,
        onCancel: noop,
      }),
    );
    const buttons = [...markup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(["Save version first", "Discard my changes", "Cancel"]);
    expect(
      text(
        createElement(DirtyDialog, {
          version: version("v1"),
          history: state({ changes }),
          onSave: noop,
          onDiscard: noop,
          onCancel: noop,
        }),
      ),
    ).toContain("The deck has 4 changes since “v2”. Before restoring “v1”:");
  });

  it("lists every file Discard will delete before it runs", () => {
    expect(discardDeletes(state({ changes }))).toEqual(["notes.md", "assets/new image.png"]);
    const shown = text(
      createElement(DirtyDialog, {
        version: version("v1"),
        history: state({ changes }),
        onSave: noop,
        onDiscard: noop,
        onCancel: noop,
      }),
    );
    expect(shown).toContain("Discard deletes these 2 new files: notes.md assets/new image.png");
    expect(shown).not.toContain("slides/01.slide.md");
  });

  it("says when Discard deletes nothing", () => {
    const shown = text(
      createElement(DirtyDialog, {
        version: version("v1"),
        history: state({ changes: [{ path: "slides/01.slide.md", status: "modified" }] }),
        onSave: noop,
        onDiscard: noop,
        onCancel: noop,
      }),
    );
    expect(shown).toContain("The deck has 1 change since “v2”.");
    expect(shown).toContain("Discard deletes no files; it puts back the changed ones.");
  });
});

describe("after a restore", () => {
  it('the undo control shows Restore "<note>"', () => {
    const client = new QueryClient();
    client.setQueryData(historyKey("dGFsaw"), { undo: 'Restore "first draft"', redo: null });
    const markup = html(
      createElement(QueryClientProvider, { client }, createElement(UndoControls, { deckId: "dGFsaw" })),
    );
    expect(markup).toContain('title="Undo: Restore &quot;first draft&quot;"');
  });

  it("restore and discard refresh the history labels like other deck writes", () => {
    expect(isDeckWrite("POST", `/api/decks/dGFsaw/versions/${"a".repeat(40)}/restore`)).toBe(true);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/discard")).toBe(true);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/versions")).toBe(false);
  });
});
