import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiError, UndoResponse } from "../../shared/api";
import { ApiRequestError, getHistory, undoDeck } from "../api";
import { DECK_WRITTEN, isTextTarget, undoShortcut } from "../undo";
import { assetsKey } from "./ImagesPanel";
import { ErrorNotice } from "./Shell";

export const historyKey = (deckId: string) => ["history", deckId] as const;

/**
 * Undo and Redo for the deck's saved changes (US-17), in the top bar. `blocked` disables both
 * with that reason (the open slide has unsaved edits). `onChanged` runs after a successful move.
 */
export function UndoControls({
  deckId,
  blocked,
  onChanged,
}: {
  deckId: string;
  blocked?: string | null;
  onChanged?: (result: UndoResponse) => void;
}) {
  const queryClient = useQueryClient();
  const history = useQuery({ queryKey: historyKey(deckId), queryFn: () => getHistory(deckId) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: historyKey(deckId) });
    window.addEventListener(DECK_WRITTEN, refresh);
    return () => window.removeEventListener(DECK_WRITTEN, refresh);
  }, [deckId, queryClient]);

  const move = async (direction: "undo" | "redo") => {
    if (busy || blocked || !history.data?.[direction]) return;
    setBusy(true);
    setError(null);
    try {
      const result = await undoDeck(deckId, direction);
      queryClient.setQueryData(historyKey(deckId), result.history);
      // Ready for the next press as soon as the server answers; the refetches run behind it.
      setBusy(false);
      for (const queryKey of [["deck", deckId], assetsKey(deckId), ["workspace"]])
        void queryClient.invalidateQueries({ queryKey });
      onChanged?.(result);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.error
          : { code: "INTERNAL", message: String((caught as Error)?.message ?? caught) },
      );
      void queryClient.invalidateQueries({ queryKey: historyKey(deckId) });
    } finally {
      setBusy(false);
    }
  };
  const latest = useRef(move);
  latest.current = move;

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z outside text fields and editors (they keep their own undo).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const direction = undoShortcut(event);
      if (!direction || isTextTarget(event.target) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      void latest.current(direction);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const button = (direction: "undo" | "redo", text: string) => {
    const label = history.data?.[direction] ?? null;
    const title = blocked ?? (label ? `${text}: ${label}` : `Nothing to ${direction}`);
    return (
      <button
        type="button"
        className="undo-button"
        disabled={busy || Boolean(blocked) || !label}
        title={title}
        aria-label={label ? `${text}: ${label}` : text}
        onClick={() => void move(direction)}
      >
        {text}
      </button>
    );
  };

  return (
    <span className="undo-controls" data-testid="undo-controls">
      {button("undo", "Undo")}
      {button("redo", "Redo")}
      {blocked && history.data?.undo ? (
        <span className="muted undo-blocked" data-testid="undo-blocked">
          {blocked}
        </span>
      ) : null}
      {error ? (
        <div className="popover" role="alert" data-testid="undo-error">
          <ErrorNotice error={error} />
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </span>
  );
}
