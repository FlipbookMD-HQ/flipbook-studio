import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { SlideRestoreResponse, Version, VersionSlide } from "../src/shared/api.js";
import { Timeline } from "../src/ui/screens/HistoryPanel.js";
import {
  SINGLE_FILE_HELP,
  SlideRestoreNotice,
  VersionSlideList,
  VersionView,
  slideRestoreBlocked,
  versionViewKey,
} from "../src/ui/screens/VersionView.js";
import { isDeckWrite } from "../src/ui/undo.js";

// US-27 · 1.2.2.2: the version view in the History panel, rendered to static markup (no DOM needed).

const SHA = "a".repeat(40);
const version: Version = {
  sha: SHA,
  note: "v1",
  author: "Ada",
  time: "2026-11-19T10:00:00.000Z",
  slidesChanged: 2,
};
const slides: VersionSlide[] = [
  { slideId: "slides/01.slide.md", index: 0, title: "Cover", template: "cover", status: "same" },
  { slideId: "slides/02.slide.md", index: 1, title: "Point", template: "flow", status: "changed" },
  { slideId: "slides/03.slide.md", index: 2, title: "", template: "flow", status: "gone" },
];
const noop = () => {};

function render(element: ReactElement, client = new QueryClient()) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));
}
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** The markup of each slide row. */
const rows = (markup: string) => markup.split('data-testid="version-slide"').slice(1);

describe("the version's slide list", () => {
  it("shows each slide with a sandboxed preview frame and changed/gone marks", () => {
    const markup = render(
      createElement(VersionSlideList, { deckId: "d", sha: SHA, slides, onRestore: noop }),
    );
    const [cover, point, gone] = rows(markup);
    expect(markup.match(/<iframe[^>]*sandbox=""/g)).toHaveLength(3);
    expect(cover).toContain('data-status="same"');
    expect(cover).not.toContain("version-slide-mark");
    expect(point).toContain('data-status="changed"');
    expect(text(point!)).toContain("changed");
    expect(gone).toContain('data-status="gone"');
    expect(text(gone!)).toContain("3. Untitled");
    expect(text(gone!)).toContain("gone");
  });

  it("Restore this slide is enabled for changed and gone slides, disabled for one that's the same", () => {
    const markup = render(
      createElement(VersionSlideList, { deckId: "d", sha: SHA, slides, onRestore: noop }),
    );
    const [cover, point, gone] = rows(markup);
    expect(markup.match(/>Restore this slide</g)).toHaveLength(3);
    expect(cover).toMatch(/disabled=""[^>]*title="Same as the deck now"/);
    expect(point).not.toContain('disabled=""');
    expect(gone).not.toContain('disabled=""');
    expect(point).toContain('aria-label="Restore slide 2 (Point) from this version"');
  });

  it("is disabled with 'Save or discard your edits first' while the open slide has unsaved edits", () => {
    const blocked = "Save or discard your edits first";
    const markup = render(
      createElement(VersionSlideList, { deckId: "d", sha: SHA, slides, blocked, onRestore: noop }),
    );
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    expect(markup.match(/title="Save or discard your edits first"/g)).toHaveLength(3);
    expect(slideRestoreBlocked(slides[1]!, blocked, false)).toBe(blocked);
    expect(slideRestoreBlocked(slides[1]!, null, true)).toBe("Busy…");
    expect(slideRestoreBlocked(slides[1]!, null, false)).toBeNull();
  });
});

describe("the version view", () => {
  const withView = () => {
    const client = new QueryClient();
    client.setQueryData(versionViewKey("d", SHA), { version, slides });
    return client;
  };

  it("lists the version's slides once loaded, with the version's note and the unsaved-edits notice", () => {
    const markup = render(
      createElement(VersionView, {
        deckId: "d",
        version,
        kind: "folder",
        blocked: "Save or discard your edits first",
        onBack: noop,
      }),
      withView(),
    );
    expect(markup).toContain('data-testid="version-view"');
    expect(text(markup)).toContain("← All versions v1");
    expect(rows(markup)).toHaveLength(3);
    expect(text(markup)).toContain("Restore this slide: Save or discard your edits first");
    expect(markup).not.toContain("version-single-help");
  });

  it("single-file decks get help text about matching by position", () => {
    const markup = render(
      createElement(VersionView, { deckId: "d", version, kind: "single", onBack: noop }),
      withView(),
    );
    expect(text(markup)).toContain(SINGLE_FILE_HELP);
    expect(SINGLE_FILE_HELP).toMatch(/matched by position/);
    expect(markup).not.toContain("slide-restore-blocked");
  });

  it("shows Loading while the version is read", () => {
    const markup = render(createElement(VersionView, { deckId: "d", version, kind: "folder", onBack: noop }));
    expect(text(markup)).toContain("Loading slides…");
  });

  it("the timeline opens a version with View slides", () => {
    const markup = renderToStaticMarkup(
      createElement(Timeline, { versions: [version], hasMore: false, onLoadMore: noop, onView: noop }),
    );
    expect(markup).toContain('aria-label="View slides of v1"');
    expect(markup).toContain(">View slides<");
    const without = renderToStaticMarkup(
      createElement(Timeline, { versions: [version], hasMore: false, onLoadMore: noop }),
    );
    expect(without).not.toContain("View slides");
  });
});

describe("after a slide restore", () => {
  const result = {
    slideId: "slides/02.slide.md",
    restoredAssets: [
      { from: "assets/chart.png", to: "assets/chart.png" },
      { from: "assets/logo.svg", to: "assets/logo-2.svg" },
    ],
    skippedAssets: [
      { path: "assets/huge.png", reason: "larger than 8 MB" },
      { path: "assets/link.svg", reason: "symlink" },
    ],
  } as unknown as SlideRestoreResponse;

  it("says what came back, which image was renamed and what was left out", () => {
    const markup = renderToStaticMarkup(createElement(SlideRestoreNotice, { title: "Point", result }));
    const said = text(markup);
    expect(said).toContain("Restored slide “Point”. Undo puts it back; no commit was made.");
    expect(said).toContain("Put back assets/chart.png.");
    expect(said).toContain(
      "assets/logo.svg was taken by a different image, so it was saved as assets/logo-2.svg",
    );
    expect(said).toContain("Left out: assets/huge.png (larger than 8 MB) assets/link.svg (symlink)");
  });

  it("a slide restore counts as a deck write (undo labels refresh); viewing doesn't", () => {
    const base = `/api/decks/dGFsaw/versions/${SHA}`;
    expect(isDeckWrite("POST", `${base}/slides/slides%2F02.slide.md/restore`)).toBe(true);
    expect(isDeckWrite("POST", `${base}/slides/%230/restore`)).toBe(true);
    expect(isDeckWrite("GET", base)).toBe(false);
    expect(isDeckWrite("GET", `${base}/slides/%230/preview`)).toBe(false);
  });
});
