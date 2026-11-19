import type { ApiError } from "../../shared/api";
import { ErrorNotice, Shell } from "./Shell";
import { UndoControls } from "./UndoControls";

/**
 * A deck that can't be shown. When its files don't load (DECK_LOAD_FAILED), Undo and Redo stay
 * in the top bar: if a change made in Studio (an undo, a restore) caused it, the user can put the
 * files back from here instead of editing them by hand.
 */
export function DeckLoadError({ deckId, error }: { deckId: string; error: ApiError }) {
  const recoverable = error.code === "DECK_LOAD_FAILED";
  return (
    <Shell actions={recoverable ? <UndoControls deckId={deckId} /> : undefined}>
      <ErrorNotice error={error} />
      {recoverable ? (
        <p className="hint" data-testid="deck-load-undo-hint">
          If a change made in Studio caused this, use Undo to put the files back.
        </p>
      ) : null}
    </Shell>
  );
}
