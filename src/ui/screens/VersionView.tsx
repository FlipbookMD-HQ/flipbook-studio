import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiError, SlideRestoreResponse, Version, VersionSlide } from "../../shared/api";
import { ApiRequestError, getVersionPreview, getVersionView, restoreSlide } from "../api";
import { ErrorNotice } from "./Shell";

// US-27: a past version's slides, with previews and changed/gone marks, and Restore this slide.

export const versionViewKey = (deckId: string, sha: string) => ["version-view", deckId, sha] as const;

/** Single-file decks match slides by position (errors-edge-cases § US-27). */
export const SINGLE_FILE_HELP =
  "This deck is a single file, so its slides are matched by position. After slides are reordered, the changed and gone marks (and the slide Restore replaces) can be off.";

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError
    ? error.error
    : { code: "INTERNAL", message: String((error as Error)?.message ?? error) };

const MARKS: Record<VersionSlide["status"], { label: string; className: string; hint: string } | null> = {
  same: null,
  changed: { label: "changed", className: "tag accent", hint: "Differs from the deck now" },
  gone: { label: "gone", className: "tag danger", hint: "Not in the deck now" },
};

/** Why Restore this slide is disabled for `slide`, or null when it can run. */
export function slideRestoreBlocked(
  slide: VersionSlide,
  blocked: string | null | undefined,
  busy: boolean,
): string | null {
  if (blocked) return blocked;
  if (busy) return "Busy…";
  if (slide.status === "same") return "Same as the deck now";
  return null;
}

/** One version slide's preview, in the same sandboxed srcdoc frame as the live preview. */
export function VersionPreview({
  deckId,
  sha,
  slideId,
  title,
}: {
  deckId: string;
  sha: string;
  slideId: string;
  title: string;
}) {
  // A version never changes, so its previews never go stale.
  const preview = useQuery({
    queryKey: ["version-preview", deckId, sha, slideId],
    queryFn: () => getVersionPreview(deckId, sha, slideId),
    staleTime: Infinity,
  });
  if (preview.isError)
    return (
      <p className="muted version-preview-error" data-testid="version-preview-error">
        Preview unavailable: {asApiError(preview.error).message}
      </p>
    );
  return (
    <div className="version-thumb">
      <iframe
        title={`Version preview: ${title || "Untitled"}`}
        sandbox=""
        srcDoc={preview.data ?? ""}
        tabIndex={-1}
        data-testid="version-preview"
      />
    </div>
  );
}

/** The version's slides with their marks and Restore this slide. */
export function VersionSlideList({
  deckId,
  sha,
  slides,
  blocked,
  busy = false,
  onRestore,
}: {
  deckId: string;
  sha: string;
  slides: VersionSlide[];
  /** Why every Restore is disabled (unsaved edits), if it is. */
  blocked?: string | null;
  busy?: boolean;
  onRestore: (slide: VersionSlide) => void;
}) {
  return (
    <ol className="version-slides" aria-label="Slides in this version">
      {slides.map((slide) => {
        const mark = MARKS[slide.status];
        const reason = slideRestoreBlocked(slide, blocked, busy);
        const title = slide.title || "Untitled";
        return (
          <li key={slide.slideId} data-testid="version-slide" data-status={slide.status}>
            <VersionPreview deckId={deckId} sha={sha} slideId={slide.slideId} title={title} />
            <div className="version-slide-info">
              <strong className="version-slide-title">
                {slide.index + 1}. {title}
              </strong>
              {mark ? (
                <span className={mark.className} title={mark.hint} data-testid="version-slide-mark">
                  {mark.label}
                </span>
              ) : null}
              <button
                type="button"
                disabled={Boolean(reason)}
                title={reason ?? `Put back slide ${slide.index + 1} as it was in this version`}
                aria-label={`Restore slide ${slide.index + 1} (${title}) from this version`}
                onClick={() => onRestore(slide)}
              >
                Restore this slide
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** What a slide restore did: the slide, renamed or restored images, and images left out. */
export function SlideRestoreNotice({ title, result }: { title: string; result: SlideRestoreResponse }) {
  const renamed = result.restoredAssets.filter((asset) => asset.from !== asset.to);
  const restored = result.restoredAssets.filter((asset) => asset.from === asset.to);
  return (
    <div className="notice" role="status" data-testid="slide-restored">
      <p>Restored slide “{title || "Untitled"}”. Undo puts it back; no commit was made.</p>
      {restored.length ? (
        <p data-testid="slide-restored-assets">Put back {restored.map((asset) => asset.to).join(", ")}.</p>
      ) : null}
      {renamed.map((asset) => (
        <p key={asset.to} data-testid="slide-renamed-asset">
          {asset.from} was taken by a different image, so it was saved as {asset.to} and the slide now uses
          that.
        </p>
      ))}
      {result.skippedAssets.length ? (
        <div data-testid="slide-skipped-assets">
          Left out:
          <ul>
            {result.skippedAssets.map((asset) => (
              <li key={asset.path}>
                <code>{asset.path}</code> ({asset.reason})
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Opening a timeline entry: that version's slides, previews and marks, and Restore this slide. */
export function VersionView({
  deckId,
  version,
  kind,
  blocked,
  onBack,
  onRestored,
}: {
  deckId: string;
  version: Version;
  kind: "folder" | "single" | null;
  /** Why Restore this slide is disabled right now (unsaved edits), if it is. */
  blocked?: string | null;
  onBack: () => void;
  onRestored?: (result: SlideRestoreResponse) => void;
}) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: versionViewKey(deckId, version.sha),
    queryFn: () => getVersionView(deckId, version.sha),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ title: string; result: SlideRestoreResponse } | null>(null);

  const restore = async (slide: VersionSlide) => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await restoreSlide(deckId, version.sha, slide.slideId);
      setDone({ title: slide.title, result });
      onRestored?.(result);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: versionViewKey(deckId, version.sha) });
    }
  };

  return (
    <section className="version-view" aria-label={`Version ${version.note}`} data-testid="version-view">
      <div className="version-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← All versions
        </button>
        <strong className="history-note">{version.note}</strong>
        <span className="muted history-meta">
          <time dateTime={version.time}>{new Date(version.time).toLocaleString()}</time> · {version.author} ·{" "}
          <code>{version.sha.slice(0, 7)}</code>
        </span>
      </div>
      {kind === "single" ? (
        <p className="muted" data-testid="version-single-help">
          {SINGLE_FILE_HELP}
        </p>
      ) : null}
      {blocked ? (
        <p className="muted" data-testid="slide-restore-blocked">
          Restore this slide: {blocked}
        </p>
      ) : null}
      {done ? <SlideRestoreNotice title={done.title} result={done.result} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {view.isPending ? <p className="muted">Loading slides…</p> : null}
      {view.isError ? <ErrorNotice error={asApiError(view.error)} /> : null}
      {view.data ? (
        <VersionSlideList
          deckId={deckId}
          sha={version.sha}
          slides={view.data.slides}
          blocked={blocked}
          busy={busy}
          onRestore={(slide) => void restore(slide)}
        />
      ) : null}
    </section>
  );
}
