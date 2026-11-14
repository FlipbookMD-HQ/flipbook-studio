import { useEffect, useRef, useState } from "react";
import type { DeckAsset } from "../../shared/api";
import { altFromPath } from "../images";
import { ImagesPanel } from "./ImagesPanel";

/**
 * Pick (or upload) a deck image and an alt text, then insert it at the cursor or replace the
 * slide's first image (US-16).
 */
export function InsertImageDialog({
  deckId,
  canReplace,
  onInsert,
  onReplace,
  onClose,
}: {
  deckId: string;
  canReplace: boolean;
  onInsert: (assetPath: string, alt: string) => void;
  onReplace: (assetPath: string, alt: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState<DeckAsset | null>(null);
  const [alt, setAlt] = useState("");
  const [altEdited, setAltEdited] = useState(false);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const pick = (asset: DeckAsset) => {
    setChosen(asset);
    if (!altEdited) setAlt(altFromPath(asset.path));
  };

  return (
    <dialog
      ref={dialog}
      className="dialog image-dialog"
      aria-labelledby="insert-image-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="insert-image-title">Insert image</h2>
      <ImagesPanel deckId={deckId} mode="pick" selected={chosen?.path ?? null} onPick={pick} />
      <label className="field">
        <span>Alt text</span>
        <input
          value={alt}
          placeholder="Describe the image for people who can't see it"
          onChange={(event) => {
            setAlt(event.target.value);
            setAltEdited(true);
          }}
        />
      </label>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        {canReplace ? (
          <button type="button" disabled={!chosen} onClick={() => chosen && onReplace(chosen.path, alt)}>
            Replace image
          </button>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={!chosen}
          onClick={() => chosen && onInsert(chosen.path, alt)}
        >
          Insert
        </button>
      </div>
    </dialog>
  );
}
