import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistoryState, Version } from "../src/shared/api.js";
import {
  AuthorForm,
  GitErrorNotice,
  HistoryStatus,
  InitOffer,
  Timeline,
  initTargets,
  saveBlockedReason,
} from "../src/ui/screens/HistoryPanel.js";

// US-23: the History panel's pieces, rendered to static markup (no DOM needed).

const html = (element: ReactElement) => renderToStaticMarkup(element);
const text = (element: ReactElement) =>
  html(element)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

const version = (note: string, slidesChanged = 1, sha = "a".repeat(40)): Version => ({
  sha,
  note,
  author: "Ada",
  time: "2026-11-19T10:00:00.000Z",
  slidesChanged,
});
const state = (extra: Partial<HistoryState>): HistoryState => ({
  state: "ready",
  reason: null,
  repoRoot: "/home/ada/decks",
  canInit: { deck: false, workspace: false },
  head: null,
  dirty: false,
  changes: [],
  detached: false,
  ...extra,
});
const noGit = state({
  state: "no-git",
  repoRoot: null,
  reason: "Git isn't installed (no git command on PATH).",
});

describe("Save version", () => {
  it("is disabled with 'No changes since <note>' when the deck is clean", () => {
    expect(saveBlockedReason(state({ head: version("first draft") }))).toBe("No changes since first draft");
    expect(saveBlockedReason(state({}))).toBe("No changes to save");
  });

  it("is enabled when the deck changed, and with no repo (the click offers git init)", () => {
    expect(saveBlockedReason(state({ dirty: true, head: version("first draft") }))).toBeNull();
    expect(saveBlockedReason(state({ state: "no-repo", repoRoot: null }))).toBeNull();
  });

  it("is disabled with the reason when git is missing or the repo is unsupported", () => {
    expect(saveBlockedReason(noGit)).toBe("Git isn't installed (no git command on PATH).");
    expect(
      saveBlockedReason(state({ state: "unsupported", reason: "The deck is in a git submodule." })),
    ).toBe("The deck is in a git submodule.");
  });
});

describe("state messages", () => {
  it("no git: History is off with its reason, and the rest of Studio still works", () => {
    const out = text(createElement(HistoryStatus, { history: noGit }));
    expect(out).toContain("History is off: Git isn't installed (no git command on PATH).");
    expect(out).toContain("Everything else in Studio works without git.");
  });

  it("unsupported: says why", () => {
    expect(
      text(createElement(HistoryStatus, { history: state({ state: "unsupported", reason: "LFS." }) })),
    ).toContain("History isn't available for this deck: LFS.");
  });

  it("ready: shows repoRoot, and a detached-HEAD label only when detached", () => {
    const attached = html(createElement(HistoryStatus, { history: state({}) }));
    expect(attached).toContain('data-testid="history-repo-root">/home/ada/decks</code>');
    expect(attached).not.toContain("detached");
    const detached = html(createElement(HistoryStatus, { history: state({ detached: true }) }));
    expect(detached).toContain('data-testid="history-detached"');
    expect(text(createElement(HistoryStatus, { history: state({ detached: true }) }))).toContain("detached");
  });

  it("no repo: says nothing happens until the user agrees", () => {
    expect(text(createElement(HistoryStatus, { history: state({ state: "no-repo" }) }))).toMatch(
      /nothing happens\s+until you say yes/,
    );
  });
});

describe("the init offer", () => {
  const noRepo = state({ state: "no-repo", repoRoot: null, canInit: { deck: true, workspace: true } });

  it("names the folder each choice creates the repository in", () => {
    const targets = initTargets(noRepo, "/home/ada/decks", { path: "talk", kind: "folder" });
    expect(targets).toEqual([
      { at: "deck", label: "the deck's folder", dir: "/home/ada/decks/talk" },
      { at: "workspace", label: "the workspace", dir: "/home/ada/decks" },
    ]);
    const out = text(createElement(InitOffer, { targets, onInit: () => {}, onCancel: () => {} }));
    expect(out).toContain("Set up git in the deck's folder/home/ada/decks/talk");
    expect(out).toContain("Set up git in the workspace/home/ada/decks");
    expect(out).toContain("no commit is made");
  });

  it("offers only the workspace for a single-file deck, and nothing once a repo exists", () => {
    expect(
      initTargets({ ...noRepo, canInit: { deck: false, workspace: true } }, "/w", {
        path: "a.slide.md",
        kind: "single",
      }).map((target) => target.at),
    ).toEqual(["workspace"]);
    expect(initTargets(state({}), "/w", { path: "talk", kind: "folder" })).toEqual([]);
  });
});

describe("errors and the author form", () => {
  it("shows git's output in a collapsible section", () => {
    const out = html(
      createElement(GitErrorNotice, {
        error: {
          code: "GIT_COMMIT_FAILED",
          message: "git commit failed: pre-commit hook",
          details: { output: "lint: slide 3 <too long>" },
        },
      }),
    );
    expect(out).toContain("git commit failed: pre-commit hook");
    expect(out).toMatch(
      /<details class="git-output"><summary>Git output<\/summary><pre>lint: slide 3 &lt;too long&gt;<\/pre><\/details>/,
    );
  });

  it("has no output section when git printed nothing", () => {
    const out = html(createElement(GitErrorNotice, { error: { code: "GIT_BUSY", message: "Git is busy." } }));
    expect(out).not.toContain("<details");
  });

  it("asks for a name and email once", () => {
    const out = text(createElement(AuthorForm, { onSubmit: () => {} }));
    expect(out).toContain("Git doesn't know who you are.");
    expect(out).toContain("Name");
    expect(out).toContain("Email");
    expect(out).toContain("Save author and version");
  });
});

describe("the timeline", () => {
  it("lists versions with note, time, author and slides changed, and Load more", () => {
    const out = text(
      createElement(Timeline, {
        versions: [version("second", 1, "b".repeat(40)), version("first draft", 3)],
        hasMore: true,
        onLoadMore: () => {},
      }),
    );
    expect(out).toContain("second");
    expect(out).toContain("1 slide changed");
    expect(out).toContain("first draft");
    expect(out).toContain("3 slides changed");
    expect(out).toContain("Ada");
    expect(out).toContain("bbbbbbb");
    expect(out).toContain("Load more");
    expect(
      html(createElement(Timeline, { versions: [version("x")], hasMore: false, onLoadMore: () => {} })),
    ).not.toContain("Load more");
  });

  it("says when there are no versions yet", () => {
    expect(text(createElement(Timeline, { versions: [], hasMore: false, onLoadMore: () => {} }))).toBe(
      "No versions yet.",
    );
  });

  it("says when a version changed no slides", () => {
    expect(
      text(
        createElement(Timeline, { versions: [version("theme", 0)], hasMore: false, onLoadMore: () => {} }),
      ),
    ).toContain("No slides changed");
  });
});
