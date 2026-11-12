import { useEffect, useRef, useState } from "react";
import type { SlideDraft } from "../../shared/api";

export interface DiskVersion {
  draft: SlideDraft;
  hash: string;
}

/**
 * FILE_CONFLICT: the slide changed on disk. Nothing is lost silently: Overwrite keeps the
 * user's draft, Reload is labelled as discarding it, and Copy puts the draft on the clipboard.
 */
export function ConflictDialog({
  disk,
  mine,
  onOverwrite,
  onReload,
  onCancel,
}: {
  disk: DiskVersion | null;
  mine: SlideDraft;
  onOverwrite: (hash: string) => void;
  onReload: (disk: DiskVersion) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mine.markdown);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <dialog ref={dialog} className="dialog conflict" aria-labelledby="conflict-title" onCancel={onCancel}>
      <h2 id="conflict-title">Changed on disk</h2>
      <p>This slide was changed outside Studio after you opened it. Choose what to keep.</p>
      {disk ? (
        <>
          <h3>Version on disk</h3>
          <pre className="disk-version" data-testid="disk-version">
            {disk.draft.markdown || "(empty)"}
          </pre>
        </>
      ) : (
        <p className="hint">The slide is no longer on disk, so it can only be saved over.</p>
      )}
      {copied === "copied" ? (
        <p className="hint" role="status">
          Your text is on the clipboard.
        </p>
      ) : null}
      {copied === "failed" ? (
        <p className="error" role="alert">
          Could not copy. Select the text in the editor and copy it by hand.
        </p>
      ) : null}
      <div className="actions">
        <button type="button" onClick={copy}>
          Copy my text
        </button>
        <button type="button" disabled={!disk} onClick={() => disk && onReload(disk)}>
          Reload (discard my changes)
        </button>
        <button
          type="button"
          className="primary"
          disabled={!disk}
          onClick={() => disk && onOverwrite(disk.hash)}
        >
          Overwrite with mine
        </button>
      </div>
    </dialog>
  );
}
