import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ApiRequestError, createDeck } from "../api";
import type { CreateDeckRequest, GenerateDeckRequest, KitRef } from "../../shared/api";
import { AiAction } from "../ai";
import { GenerateProgress } from "./GenerateProgress";

/** Suggests a deck name from the title: lowercase ASCII, digits and dashes, at most 60 characters. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

type FieldErrors = Partial<Record<"name" | "title" | "kind" | "group", string>>;

function fieldErrors(error: unknown): { fields: FieldErrors; general: string | null } {
  if (!(error instanceof ApiRequestError))
    return { fields: {}, general: error ? String((error as Error).message) : null };
  const { code, message, details } = error.error;
  if (code === "DECK_EXISTS") return { fields: { name: `${message} Pick another name.` }, general: null };
  if (code === "VALIDATION_FAILED" && Array.isArray(details?.fields)) {
    const fields: FieldErrors = {};
    for (const field of details.fields as Array<{ path: string; message: string }>) {
      fields[field.path as keyof FieldErrors] = field.message;
    }
    return { fields, general: null };
  }
  return { fields: {}, general: message };
}

export function NewDeckDialog({ kits, onClose }: { kits: KitRef[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [kind, setKind] = useState<CreateDeckRequest["kind"]>("folder");
  const [group, setGroup] = useState("");
  const [mode, setMode] = useState<"blank" | "ai">("blank");
  const [sourceKind, setSourceKind] = useState<"topic" | "text">("topic");
  const [source, setSource] = useState("");
  const [language, setLanguage] = useState("");
  // A running generation: its request and the controller that cancels it.
  const [run, setRun] = useState<{
    request: GenerateDeckRequest;
    controller: AbortController;
    key: number;
  } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const running = Boolean(run);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const create = useMutation({
    mutationFn: createDeck,
    onSuccess: async (deck) => {
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      queryClient.setQueryData(["deck", deck.id], deck);
      navigate(`/decks/${deck.id}`);
    },
  });
  const { fields, general } = fieldErrors(create.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "blank") return create.mutate({ name, title, kind, group: group || null });
    if (!source.trim()) return;
    setRun({
      key: Date.now(),
      controller: new AbortController(),
      request: {
        name,
        title,
        kind,
        group: group || null,
        source: sourceKind === "topic" ? { topic: source.trim() } : { text: source },
        ...(language.trim() ? { language: language.trim() } : {}),
      },
    });
  }

  /** Closing mid-run asks first; confirming cancels the run, which removes everything it wrote. */
  const requestClose = () => {
    if (running) setConfirmStop(true);
    else dialog.current?.close();
  };
  const stop = () => {
    run?.controller.abort();
    setRun(null);
    setConfirmStop(false);
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      className={mode === "ai" ? "dialog wide" : "dialog"}
      aria-labelledby="new-deck-title"
      onClose={onClose}
      onCancel={(event) => {
        if (!running) return;
        event.preventDefault();
        setConfirmStop(true);
      }}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="new-deck-title">New deck</h2>
        <div className="mode-tabs">
          <button
            type="button"
            aria-pressed={mode === "blank"}
            disabled={running}
            onClick={() => setMode("blank")}
          >
            Blank or from a kit
          </button>
          <AiAction
            onClick={() => setMode("ai")}
            disabled={running}
            title="Write the deck with your local model"
          >
            Generate with AI
          </AiAction>
        </div>
        {run ? (
          <p className="run-summary">
            <strong>{run.request.title}</strong> · {run.request.name} · {run.request.group ?? "no kit"}
          </p>
        ) : null}
        <fieldset className="plain" disabled={running} hidden={running}>
          <label className="field">
            <span>Title</span>
            <input
              name="title"
              value={title}
              maxLength={120}
              required
              autoFocus
              aria-invalid={Boolean(fields.title)}
              onChange={(event) => {
                setTitle(event.target.value);
                if (!nameEdited) setName(slugify(event.target.value));
              }}
            />
            {fields.title ? <small className="field-error">{fields.title}</small> : null}
          </label>

          <label className="field">
            <span>Name</span>
            <input
              name="name"
              value={name}
              maxLength={60}
              required
              pattern="[a-z0-9-]{1,60}"
              aria-invalid={Boolean(fields.name)}
              aria-describedby="name-hint"
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
            />
            <small id="name-hint" className="hint">
              The folder or file name: lowercase letters, digits and dashes.
            </small>
            {fields.name ? (
              <small className="field-error" role="alert">
                {fields.name}
              </small>
            ) : null}
          </label>

          <fieldset className="field">
            <legend>Kind</legend>
            <label className="choice">
              <input
                type="radio"
                name="kind"
                checked={kind === "folder"}
                onChange={() => setKind("folder")}
              />
              Folder <small className="hint">presentation.yml plus one file per slide</small>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="kind"
                checked={kind === "single"}
                onChange={() => setKind("single")}
              />
              Single file <small className="hint">one .slide.md with every slide</small>
            </label>
          </fieldset>

          <fieldset className="field kit-picker">
            <legend>Media kit</legend>
            <label className="choice">
              <input type="radio" name="group" checked={group === ""} onChange={() => setGroup("")} />
              None <small className="hint">a blank deck with one slide</small>
            </label>
            {kits.map((kit) => (
              <label className="choice" key={`${kit.scope}:${kit.name}`}>
                <input
                  type="radio"
                  name="group"
                  value={kit.name}
                  checked={group === kit.name}
                  onChange={() => setGroup(kit.name)}
                />
                {kit.name} <span className="badge">{kit.scope === "builtin" ? "built-in" : "library"}</span>
                {kit.description ? <small className="hint">{kit.description}</small> : null}
              </label>
            ))}
            {fields.group ? <small className="field-error">{fields.group}</small> : null}
          </fieldset>

          {mode === "ai" ? (
            <fieldset className="field">
              <legend>Source</legend>
              <label className="choice">
                <input
                  type="radio"
                  name="source-kind"
                  checked={sourceKind === "topic"}
                  onChange={() => setSourceKind("topic")}
                />
                A topic
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="source-kind"
                  checked={sourceKind === "text"}
                  onChange={() => setSourceKind("text")}
                />
                Paste text <small className="hint">its facts, order and language are kept</small>
              </label>
              {sourceKind === "topic" ? (
                <input
                  aria-label="Topic"
                  value={source}
                  maxLength={2000}
                  placeholder="What should the deck be about?"
                  onChange={(event) => setSource(event.target.value)}
                />
              ) : (
                <textarea
                  aria-label="Source text"
                  rows={8}
                  value={source}
                  placeholder="Paste an article, notes or a document"
                  onChange={(event) => setSource(event.target.value)}
                />
              )}
              <label className="field">
                <span>Language (optional)</span>
                <input
                  value={language}
                  maxLength={60}
                  placeholder={sourceKind === "text" ? "Same as the text" : "Same as the topic"}
                  onChange={(event) => setLanguage(event.target.value)}
                />
              </label>
            </fieldset>
          ) : null}
        </fieldset>

        {run ? (
          <GenerateProgress
            key={run.key}
            request={run.request}
            controller={run.controller}
            onFinished={() => setRun(null)}
          />
        ) : null}

        {confirmStop ? (
          <div className="confirm" role="alertdialog" aria-label="Stop generating?">
            <p>Stop generating? Nothing will be saved.</p>
            <button type="button" onClick={() => setConfirmStop(false)}>
              Keep going
            </button>
            <button type="button" className="danger" onClick={stop}>
              Stop and discard
            </button>
          </div>
        ) : null}

        {general ? (
          <p className="error" role="alert">
            {general}
          </p>
        ) : null}

        <div className="actions">
          <button type="button" onClick={requestClose}>
            Cancel
          </button>
          {mode === "blank" ? (
            <button type="submit" className="primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create deck"}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={running || !source.trim()}>
              {running ? "Generating…" : "Generate"}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
