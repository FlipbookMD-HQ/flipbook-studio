import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, addSlide, deleteSlide, reorderSlides } from "../api";
import type { ApiError, DeckDetail, SlideDoc, StructureResponse } from "../../shared/api";
import { ErrorNotice } from "./Shell";

const NEW_SLIDE = {
  markdown: "# New slide",
  template: null,
  type: null,
  notes: "",
  title: null,
  directives: {},
};

/** The hash that guards structure changes: the manifest's, or the single file's. */
function structureHash(deck: DeckDetail): string {
  const key = deck.kind === "folder" ? "presentation.yml" : deck.path;
  return deck.hashes[key]!;
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) };
}

/**
 * The editor's slide list: open a slide, drag (or Space + arrows) to reorder, add after the
 * current slide, delete with confirmation. Structure changes are off while the open slide has
 * unsaved changes. `onChanged` gets the new deck and the slide to show next.
 */
export function SlideList({
  deck,
  currentId,
  locked,
  onOpen,
  onChanged,
}: {
  deck: DeckDetail;
  currentId: string;
  locked: boolean;
  onOpen: () => void;
  onChanged: (slideId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const current = deck.slides.find((slide) => slide.id === currentId);
  const disabled = locked || busy;
  const lockedReason = locked ? "Save or discard your changes first." : undefined;

  function apply(result: StructureResponse, nextIndex: number) {
    queryClient.setQueryData<DeckDetail>(["deck", deck.id], (data) =>
      data ? { ...data, slides: result.slides, hashes: result.hashes } : data,
    );
    const index = Math.max(0, Math.min(nextIndex, result.slides.length - 1));
    onChanged(result.slides[index]!.id);
  }

  async function run(action: () => Promise<void>, rollback?: DeckDetail) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (rollback) queryClient.setQueryData(["deck", deck.id], rollback);
      setError(asApiError(failure));
      // A conflict means the deck changed elsewhere: reload it so the next try uses fresh hashes.
      if (failure instanceof ApiRequestError && failure.error.code === "FILE_CONFLICT") {
        void queryClient.invalidateQueries({ queryKey: ["deck", deck.id] });
      }
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const ids = deck.slides.map((slide) => slide.id);
    const order = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    const before = deck;
    // Optimistic: show the new order now; roll back if the server refuses.
    const byId = new Map(deck.slides.map((slide) => [slide.id, slide]));
    queryClient.setQueryData<DeckDetail>(["deck", deck.id], {
      ...deck,
      slides: order.map((id, index) => ({ ...byId.get(id)!, index })),
    });
    void run(async () => {
      const result = await reorderSlides(deck.id, order, structureHash(before));
      apply(result, order.indexOf(currentId));
    }, before);
  }

  function add() {
    void run(async () => {
      const result = await addSlide(deck.id, structureHash(deck), currentId, NEW_SLIDE);
      apply(result, result.slide.index);
    });
  }

  function remove() {
    setConfirming(false);
    const index = current?.index ?? 0;
    void run(async () => {
      const result = await deleteSlide(deck.id, currentId, structureHash(deck));
      apply(result, index);
    });
  }

  const last = deck.slides.length <= 1;
  return (
    <nav className="slide-list" aria-label="Slides">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{ announcements: announcements(deck.slides) }}
      >
        <SortableContext items={deck.slides.map((slide) => slide.id)} strategy={verticalListSortingStrategy}>
          <ol>
            {deck.slides.map((slide) => (
              <SlideRow
                key={slide.id}
                deckId={deck.id}
                slide={slide}
                current={slide.id === currentId}
                disabled={disabled}
                onOpen={onOpen}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="slide-actions">
        <button type="button" disabled={disabled} title={lockedReason} onClick={add}>
          Add slide after
        </button>
        <button
          type="button"
          className="danger"
          disabled={disabled || last}
          title={last ? "A deck needs at least one slide." : lockedReason}
          onClick={() => setConfirming(true)}
        >
          Delete slide
        </button>
      </div>
      {locked ? <p className="hint">{lockedReason}</p> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {confirming && current ? (
        <DeleteDialog
          slide={current}
          file={deck.kind === "folder" ? current.file : null}
          onCancel={() => setConfirming(false)}
          onConfirm={remove}
        />
      ) : null}
    </nav>
  );
}

/** Screen-reader messages that name slides by position and title, not by file path. */
function announcements(slides: SlideDoc[]): Announcements {
  const name = (id: UniqueIdentifier | undefined) => {
    const slide = slides.find((item) => item.id === id);
    return slide ? `slide ${slide.index + 1}, ${slide.title || "Untitled"}` : "the list";
  };
  return {
    onDragStart: ({ active }) =>
      `Picked up ${name(active.id)}. Use the arrow keys to move it, Space to drop.`,
    onDragOver: ({ active, over }) => `${name(active.id)} is over ${name(over?.id)}.`,
    onDragEnd: ({ active, over }) => `Dropped ${name(active.id)} at ${name(over?.id)}.`,
    onDragCancel: ({ active }) => `Cancelled. ${name(active.id)} is back where it was.`,
  };
}

function SlideRow({
  deckId,
  slide,
  current,
  disabled,
  onOpen,
}: {
  deckId: string;
  slide: SlideDoc;
  current: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    disabled,
  });
  const label = `${slide.index + 1}. ${slide.title || "Untitled"}`;
  return (
    <li
      ref={setNodeRef}
      className={isDragging ? "slide-row dragging" : "slide-row"}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="slide-row"
    >
      <button
        type="button"
        className="drag-handle"
        aria-label={`Move slide ${label}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <Link
        to={`/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`}
        aria-current={current ? "page" : undefined}
        onClick={onOpen}
      >
        {label}
      </Link>
    </li>
  );
}

function DeleteDialog({
  slide,
  file,
  onCancel,
  onConfirm,
}: {
  slide: SlideDoc;
  file: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="delete-title" onCancel={onCancel}>
      <h2 id="delete-title">Delete slide {slide.index + 1}?</h2>
      <p>
        “{slide.title || "Untitled"}” will be removed from the deck
        {file ? (
          <>
            {" "}
            and <code>{file}</code> deleted from disk
          </>
        ) : null}
        .
      </p>
      <div className="actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Delete
        </button>
      </div>
    </dialog>
  );
}
