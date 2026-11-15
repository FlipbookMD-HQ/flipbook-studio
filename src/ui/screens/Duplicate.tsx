import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { ApiError, KitKind } from "../../shared/api";
import { ApiRequestError, copyKit, duplicateDeck, getWorkspace } from "../api";
import { blueprintPath } from "./BlueprintsScreen";
import { kitPath } from "./MediaKitsScreen";
import { slugify } from "./NewDeckDialog";
import { ErrorNotice } from "./Shell";
import { templatePath } from "./TemplatesScreen";
import { themePath } from "./ThemesScreen";

// US-20: Duplicate for decks (D26) and kit pieces (D27).

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

/** `<base>-copy`, or `-copy-2`, `-copy-3`… when taken (case-insensitive), within `max` characters. */
export function copyName(base: string, taken: Iterable<string>, max = 60): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const name = `${base.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** `<title> (copy)`, cut to fit 120 characters. */
export function copyTitle(title: string): string {
  const suffix = " (copy)";
  return `${title.slice(0, 120 - suffix.length).trimEnd()}${suffix}`;
}

/** The name part of a deck path: `talks/q3` → `q3`, `intro.slide.md` → `intro`. */
export function deckBaseName(deckPath: string): string {
  return (deckPath.split("/").pop() ?? deckPath).replace(/\.slide\.md$/, "");
}

function useDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return dialog;
}

function DuplicateDeckDialog({ deckId, onClose }: { deckId: string; onClose: () => void }) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const deck = workspace.data?.decks.find((item) => item.id === deckId);
  const [title, setTitle] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [nameEdited, setNameEdited] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  // Prefill once the workspace (and so the deck's title and the taken names) is known.
  useEffect(() => {
    if (!deck || title != null) return;
    const taken = (workspace.data?.decks ?? []).map((item) => deckBaseName(item.path));
    setTitle(copyTitle(deck.title || deckBaseName(deck.path)));
    setName(copyName(deckBaseName(deck.path), taken));
  }, [deck, title, workspace.data]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (title == null || name == null) return;
    setSaving(true);
    setError(null);
    try {
      const copy = await duplicateDeck(deckId, { name, title });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      dialog.current?.close();
      navigate(`/decks/${copy.deckId}`, { state: { duplicatedFrom: deck?.title, skipped: copy.skipped } });
    } catch (reason) {
      setError(asApiError(reason));
    } finally {
      setSaving(false);
    }
  };

  const nameError =
    error && (error.code === "DECK_EXISTS" || error.code === "VALIDATION_FAILED") ? error : null;
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="duplicate-deck-title" onClose={onClose}>
      <h2 id="duplicate-deck-title">Duplicate deck</h2>
      {deck == null || title == null || name == null ? (
        <p>Loading…</p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p className="muted">
            Copies every file of <strong>{deck.title}</strong> except exports in <code>dist/</code>, hidden
            files and symlinks. The copy is saved next to the original.
          </p>
          <label className="field">
            <span>Title</span>
            <input
              name="title"
              value={title}
              maxLength={120}
              required
              autoFocus
              onChange={(event) => {
                setTitle(event.target.value);
                if (!nameEdited) setName(slugify(event.target.value));
              }}
            />
          </label>
          <label className="field">
            <span>Name</span>
            <input
              name="name"
              value={name}
              maxLength={60}
              required
              pattern="[a-z0-9-]{1,60}"
              title="Lowercase letters, digits and dashes"
              aria-invalid={nameError ? "true" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
            {nameError ? (
              <small className="field-error" role="alert">
                {nameError.code === "DECK_EXISTS"
                  ? `${nameError.message} Pick another name.`
                  : nameError.message}
              </small>
            ) : null}
          </label>
          {error && !nameError ? <ErrorNotice error={error} /> : null}
          <div className="actions">
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Duplicating…" : "Duplicate"}
            </button>
            <button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A Duplicate button for a deck card or the deck screen. */
export function DuplicateDeckButton({ deckId, className }: { deckId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Duplicate
      </button>
      {open ? <DuplicateDeckDialog deckId={deckId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const KIND_LABELS: Record<KitKind, string> = {
  theme: "theme",
  template: "template",
  blueprint: "blueprint",
  group: "media kit",
};

/** Where a library kit piece is edited. */
export function libraryEditorPath(kind: KitKind, name: string): string {
  if (kind === "theme") return themePath("library", name);
  if (kind === "template") return templatePath("library", name);
  if (kind === "blueprint") return blueprintPath("library", name);
  return kitPath("library", name);
}

function DuplicateKitDialog({
  kind,
  name,
  scope,
  onClose,
}: {
  kind: KitKind;
  name: string;
  scope: "library" | "builtin";
  onClose: () => void;
}) {
  const dialog = useDialog();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const [toName, setToName] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const label = KIND_LABELS[kind];

  useEffect(() => {
    if (toName != null || !workspace.data) return;
    const { library } = workspace.data;
    // Templates and media kits share the templates/ folder, so their names clash with each other.
    const pool =
      kind === "theme"
        ? library.themes
        : kind === "blueprint"
          ? library.blueprints
          : [...library.templates, ...library.groups];
    setToName(
      copyName(
        name,
        pool.filter((ref) => ref.scope === "library").map((ref) => ref.name),
      ),
    );
  }, [workspace.data, toName, kind, name]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (toName == null) return;
    setSaving(true);
    setError(null);
    try {
      const copy = await copyKit(kind, name, { toName, scope });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      dialog.current?.close();
      navigate(libraryEditorPath(kind, copy.ref.name));
    } catch (reason) {
      setError(asApiError(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="duplicate-kit-title" onClose={onClose}>
      <h2 id="duplicate-kit-title">Duplicate {label}</h2>
      {toName == null ? (
        <p>Loading…</p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p className="muted">
            Saves a copy of <strong>{name}</strong> in your library, then opens it.
          </p>
          <label className="field">
            <span>Name of the copy</span>
            <input
              name="toName"
              value={toName}
              maxLength={60}
              required
              autoFocus
              aria-invalid={error ? "true" : undefined}
              onChange={(event) => setToName(event.target.value)}
            />
          </label>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="actions">
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Duplicating…" : "Duplicate"}
            </button>
            <button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A Duplicate button for a library or built-in kit piece (list rows and editors). */
export function DuplicateKitButton({
  kind,
  name,
  scope,
  className = "link",
}: {
  kind: KitKind;
  name: string;
  scope: "library" | "builtin";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Duplicate ${name}`}
        onClick={() => setOpen(true)}
      >
        Duplicate
      </button>
      {open ? (
        <DuplicateKitDialog kind={kind} name={name} scope={scope} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
