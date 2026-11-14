import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { ApiRequestError, getDeck, previewSlide, saveSlide } from "../api";
import type { ApiError, DeckDetail, SlideDraft, Violation } from "../../shared/api";
import { ConflictDialog, type DiskVersion } from "./ConflictDialog";
import { MarkdownEditor } from "./MarkdownEditor";
import { SlideList } from "./SlideList";
import { SlideViolations, ViolationsPanel, violationsFor } from "./Violations";
import { ErrorNotice, Shell } from "./Shell";
import { DeckActions } from "./DeckActions";
import { AiPanel } from "./AiPanel";
import { ChatPanel } from "./ChatPanel";
import { InsertImageDialog } from "./InsertImageDialog";
import { assetsKey, uploadFiles } from "./ImagesPanel";
import { altFromPath, hasImage, imageInsertion, imageLine, replaceFirstImage } from "../images";
import type { EditorView } from "codemirror";

const PREVIEW_DELAY_MS = 250;

function same(a: SlideDraft, b: SlideDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiRequestError
    ? error.error
    : { code: "INTERNAL", message: String((error as Error)?.message ?? error) };
}

export function SlideEditor() {
  const { id = "", slideId: rawSlideId = "" } = useParams();
  const slideId = rawSlideId;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: () => getDeck(id) });

  const slide = deck.data?.slides.find((item) => item.id === slideId) ?? null;
  const [base, setBase] = useState<{ draft: SlideDraft; hash: string } | null>(null);
  const [draft, setDraft] = useState<SlideDraft | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Violations from the last draft preview (the whole deck with the draft applied).
  const [liveViolations, setLiveViolations] = useState<Violation[] | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ disk: DiskVersion | null } | null>(null);
  const loadedFor = useRef<string | null>(null);
  // US-16: images.
  const editorView = useRef<EditorView | null>(null);
  const [imageDialog, setImageDialog] = useState(false);
  const [imageErrors, setImageErrors] = useState<{ name: string; error: ApiError }[]>([]);
  const [imageBusy, setImageBusy] = useState(false);

  // Load the slide's saved draft when the slide (or the deck) first arrives.
  useEffect(() => {
    if (!deck.data || !slide || loadedFor.current === `${id}:${slideId}`) return;
    loadedFor.current = `${id}:${slideId}`;
    const saved = { draft: slide.draft, hash: deck.data.hashes[slide.file]! };
    setBase(saved);
    setDraft(saved.draft);
    setPreview(slide.html);
    setPreviewError(null);
    setLiveViolations(null);
  }, [deck.data, slide, id, slideId]);

  const dirty = Boolean(base && draft && !same(base.draft, draft));

  // Debounced preview: the latest request always wins; older responses are dropped.
  const latest = useRef(0);
  useEffect(() => {
    if (!draft || !base || same(base.draft, draft)) return;
    const ticket = ++latest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await previewSlide(id, slideId, draft, controller.signal);
        if (ticket !== latest.current) return;
        setPreview(result.html);
        setLiveViolations(result.violations);
        setPreviewError(null);
      } catch (error) {
        if (ticket !== latest.current || controller.signal.aborted) return;
        setPreviewError(asApiError(error));
      }
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, base, id, slideId]);

  const applySaved = useCallback(
    (result: Awaited<ReturnType<typeof saveSlide>>) => {
      queryClient.setQueryData<DeckDetail>(["deck", id], (current) =>
        current
          ? {
              ...current,
              hashes: { ...current.hashes, ...result.hashes },
              violations: result.violations,
              slides: current.slides.map((item) => (item.id === slideId ? result.slide : item)),
            }
          : current,
      );
      const saved = { draft: result.slide.draft, hash: result.hashes[result.slide.file]! };
      setBase(saved);
      setDraft(saved.draft);
      setPreview(result.slide.html);
      setLiveViolations(null);
      if (result.slide.id !== slideId) {
        loadedFor.current = `${id}:${result.slide.id}`;
        navigate(`/decks/${id}/slides/${encodeURIComponent(result.slide.id)}`, { replace: true });
      }
    },
    [queryClient, id, slideId, navigate],
  );

  const save = useCallback(
    async (hash?: string) => {
      if (!draft || !base || saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        applySaved(await saveSlide(id, slideId, hash ?? base.hash, draft));
        setConflict(null);
      } catch (error) {
        const apiError = asApiError(error);
        if (apiError.code === "FILE_CONFLICT") {
          const fresh = await getDeck(id).catch(() => null);
          const onDisk = fresh?.slides.find((item) => item.id === slideId);
          setConflict({
            disk: onDisk && fresh ? { draft: onDisk.draft, hash: fresh.hashes[onDisk.file]! } : null,
          });
        } else {
          setSaveError(apiError);
        }
      } finally {
        setSaving(false);
      }
    },
    [draft, base, saving, id, slideId, applySaved],
  );

  // Cmd/Ctrl+S saves.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Unsaved changes: ask before leaving inside Studio, and let the browser warn on tab close.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (deck.isPending) return <Shell>Loading slide…</Shell>;
  if (deck.isError) {
    return (
      <Shell>
        <ErrorNotice error={asApiError(deck.error)} />
      </Shell>
    );
  }
  if (!slide) {
    return (
      <Shell>
        <ErrorNotice
          error={{ code: "SLIDE_NOT_FOUND", message: "This slide is no longer in the deck.", path: slideId }}
        />
      </Shell>
    );
  }
  if (!draft) return <Shell>Loading slide…</Shell>;

  const data = deck.data;
  // While the draft differs from disk, the last preview's check is the live one.
  const violations = dirty && liveViolations ? liveViolations : data.violations;
  const update = (patch: Partial<SlideDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const templateError = previewError?.details?.field === "template" ? previewError.message : null;

  /** Puts image lines at `pos` in the editor (each in its own paragraph) and moves the cursor after them. */
  const insertImages = (lines: string[], pos?: number) => {
    if (!lines.length) return;
    const view = editorView.current;
    const doc = view ? view.state.doc.toString() : draft.markdown;
    const at = Math.min(pos ?? (view ? view.state.selection.main.head : doc.length), doc.length);
    const text = imageInsertion(doc, at, lines.join("\n\n"));
    if (view) {
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
      view.focus();
    } else update({ markdown: doc.slice(0, at) + text + doc.slice(at) });
  };

  const dropImages = async (files: File[], pos: number) => {
    setImageBusy(true);
    const { uploaded, failed } = await uploadFiles(data.id, files);
    setImageBusy(false);
    setImageErrors(failed);
    if (uploaded.length) void queryClient.invalidateQueries({ queryKey: assetsKey(data.id) });
    insertImages(
      uploaded.map((asset) => imageLine(altFromPath(asset.path), asset.path)),
      pos,
    );
  };

  return (
    <Shell
      crumb={
        <>
          <Link to={`/decks/${id}`}>{data.title}</Link> · slide {slide.index + 1}
        </>
      }
      actions={<DeckActions deckId={id} slideIndex={slide.index} />}
    >
      <ViolationsPanel
        deckId={id}
        slides={data.slides}
        violations={violations}
        hasBlueprint={data.hasBlueprint}
        currentSlideId={slideId}
      />
      <div className="editor">
        <SlideList
          deck={data}
          violations={violations}
          currentId={slideId}
          locked={dirty || saving}
          onOpen={() => (loadedFor.current = null)}
          onChanged={(next) => {
            // The structure write changed hashes (and, in single files, slide IDs): reload the slide.
            loadedFor.current = null;
            if (next !== slideId)
              navigate(`/decks/${id}/slides/${encodeURIComponent(next)}`, { replace: true });
          }}
        />

        <section className="editor-main" aria-label="Slide">
          <div className="editor-bar">
            <span className={dirty ? "status dirty" : "status"} data-testid="save-status">
              {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
            </span>
            <span className="editor-bar-actions">
              {base ? (
                <AiPanel
                  deckId={id}
                  slideId={slideId}
                  baseHash={base.hash}
                  dirty={dirty || saving}
                  onApplied={(result) => {
                    if (!result.applied.length) return;
                    // Reload the slide and every hash from disk once the refetch lands.
                    loadedFor.current = null;
                    void queryClient.invalidateQueries({ queryKey: ["deck", id] });
                  }}
                />
              ) : null}
              <button
                type="button"
                className="primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                Save
              </button>
            </span>
          </div>
          {saveError ? <ErrorNotice error={saveError} /> : null}
          {data.hasBlueprint ? <SlideViolations violations={violationsFor(violations, slide)} /> : null}

          <div className="form-grid">
            <label className="field">
              <span>Template</span>
              <select
                value={draft.template ?? ""}
                aria-invalid={Boolean(templateError)}
                onChange={(event) => update({ template: event.target.value || null })}
              >
                <option value="">Default</option>
                {data.templates.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {templateError ? <small className="field-error">{templateError}</small> : null}
            </label>
            <label className="field">
              <span>Type</span>
              <input
                value={draft.type ?? ""}
                list="slide-types"
                onChange={(event) => update({ type: event.target.value.trim() || null })}
              />
              <datalist id="slide-types">
                {data.types.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Title</span>
              <input
                value={draft.title ?? ""}
                placeholder="From the first # heading"
                title={
                  data.kind === "single"
                    ? "Single-file slides take their title from the first # heading."
                    : undefined
                }
                disabled={data.kind === "single"}
                onChange={(event) => update({ title: event.target.value === "" ? null : event.target.value })}
              />
            </label>
          </div>

          <div className="field">
            <div className="markdown-head">
              <span>Markdown</span>
              <button type="button" onClick={() => setImageDialog(true)}>
                Insert image
              </button>
            </div>
            <MarkdownEditor
              value={draft.markdown}
              onChange={(markdown) => update({ markdown })}
              viewRef={editorView}
              onFiles={(files, pos) => void dropImages(files, pos)}
            />
            {imageBusy ? <p className="muted">Uploading…</p> : null}
            {imageErrors.length ? (
              <ul className="upload-errors" role="alert" data-testid="upload-errors">
                {imageErrors.map(({ name, error }) => (
                  <li key={name}>
                    <strong>{name}</strong>: {error.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {imageDialog ? (
            <InsertImageDialog
              deckId={data.id}
              canReplace={hasImage(draft.markdown)}
              onClose={() => setImageDialog(false)}
              onInsert={(assetPath, alt) => {
                setImageDialog(false);
                insertImages([imageLine(alt, assetPath)]);
              }}
              onReplace={(assetPath, alt) => {
                setImageDialog(false);
                const next = replaceFirstImage(draft.markdown, alt, assetPath);
                if (next !== null) update({ markdown: next });
              }}
            />
          ) : null}

          <label className="field">
            <span>Speaker notes</span>
            <textarea
              rows={4}
              value={draft.notes}
              onChange={(event) => update({ notes: event.target.value })}
            />
          </label>

          {Object.keys(draft.directives).length ? (
            <div className="field">
              <span>Other directives (kept as they are)</span>
              <dl className="directives">
                {Object.entries(draft.directives).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </section>

        <section className="preview" aria-label="Preview">
          <div className="preview-frame">
            {/* Rendered slide HTML only ever appears here: no allow-scripts, no allow-same-origin. */}
            <iframe title="Slide preview" sandbox="" srcDoc={preview ?? ""} data-testid="preview" />
          </div>
          {previewError && !templateError ? <ErrorNotice error={previewError} /> : null}
        </section>
      </div>

      <ChatPanel
        deck={data}
        slideId={slideId}
        onApplied={(result) => {
          if (!result.applied.length) return;
          // Reload the slide list, violations and hashes. Unsaved edits stay: if the chat changed
          // this slide too, saving them shows the usual conflict dialog.
          if (!dirty && !saving) loadedFor.current = null;
          void queryClient.invalidateQueries({ queryKey: ["deck", id] });
        }}
      />

      {conflict ? (
        <ConflictDialog
          disk={conflict.disk}
          mine={draft}
          onCancel={() => setConflict(null)}
          onOverwrite={(hash) => void save(hash)}
          onReload={(disk) => {
            setBase(disk);
            setDraft(disk.draft);
            setConflict(null);
            void queryClient.invalidateQueries({ queryKey: ["deck", id] });
            loadedFor.current = `${id}:${slideId}`;
            void previewSlide(id, slideId, null).then((result) => setPreview(result.html));
          }}
        />
      ) : null}

      {blocker.state === "blocked" ? (
        <LeaveDialog onStay={() => blocker.reset()} onLeave={() => blocker.proceed()} />
      ) : null}
    </Shell>
  );
}

function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="leave-title" onCancel={onStay}>
      <h2 id="leave-title">Leave without saving?</h2>
      <p>This slide has unsaved changes.</p>
      <div className="actions">
        <button type="button" onClick={onStay}>
          Stay
        </button>
        <button type="button" className="primary" onClick={onLeave}>
          Leave and discard
        </button>
      </div>
    </dialog>
  );
}
