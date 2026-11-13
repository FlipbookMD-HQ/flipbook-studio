import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import type { ApiError, KitDoc } from "../../shared/api";
import {
  LAYOUTS,
  ROLES,
  nameProblem,
  regionProblem,
  templatePatch,
  templateSource,
  type Align,
  type TemplateFields,
} from "../../shared/templateFields";
import { ApiRequestError, createKit, getKit, getWorkspace, previewKit, updateKit } from "../api";
import { GridEditor } from "./GridEditor";
import { ErrorNotice, Shell } from "./Shell";
import { templatePath } from "./TemplatesScreen";
import { DraftKitButton, kitDraftOf } from "./DraftKitDialog";

const DEFAULT: TemplateFields = {
  column: 1,
  row: 1,
  width: 3,
  height: 1,
  align: "start",
  role: null,
  layout: null,
};
const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

function fieldsOf(value: unknown): TemplateFields | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    column: Number(record.column),
    row: Number(record.row),
    width: Number(record.width),
    height: Number(record.height),
    align: (record.align as Align) ?? "start",
    role: (record.role as string | null) ?? null,
    layout: (record.layout as string | null) ?? null,
  };
}

/** The current templates.yml hash and this template's fields in a deck, or nulls when missing. */
async function deckEntry(
  name: string,
  deckId: string,
): Promise<{ hash: string | null; fields: TemplateFields | null }> {
  try {
    const doc = await getKit("template", name, "deck", deckId);
    return { hash: doc.hash, fields: fieldsOf((doc.parsed as Record<string, unknown> | null)?.[name]) };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { hash: null, fields: null };
    throw error;
  }
}

interface Outcome {
  scope: string;
  ok: boolean;
  message: string;
}

/** Kits → Templates → new or existing template: grid, alignment, role and layout, with a live preview. */
export function TemplateEditor() {
  const params = useParams();
  const existing = params.name
    ? {
        scope: params.deckId ? ("deck" as const) : ("library" as const),
        name: params.name,
        deckId: params.deckId,
      }
    : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const kit = useQuery({
    queryKey: ["kit", "template", existing?.scope, existing?.deckId, existing?.name],
    queryFn: () => getKit("template", existing!.name, existing!.scope, existing!.deckId),
    enabled: Boolean(existing),
  });

  const [name, setName] = useState(existing?.name ?? "");
  const [fields, setFields] = useState<TemplateFields | null>(existing ? null : DEFAULT);
  const [original, setOriginal] = useState<TemplateFields | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [toLibrary, setToLibrary] = useState(true);
  const [toDeck, setToDeck] = useState(false);
  const [deckId, setDeckId] = useState<string>(existing?.deckId ?? "");
  const [html, setHtml] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);
  const location = useLocation();
  const draft = existing ? null : kitDraftOf(location);

  // An AI draft (US-14) fills the new-template form, unsaved; each new draft replaces it.
  useEffect(() => {
    if (!draft) return;
    const drafted = fieldsOf(parseYaml(draft.source));
    if (!drafted) return;
    leaving.current = false;
    setName(draft.name);
    setFields(drafted);
    setOutcomes([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  useEffect(() => {
    if (!existing || !kit.data) return;
    const parsed =
      existing.scope === "deck"
        ? (kit.data.parsed as Record<string, unknown> | null)?.[existing.name]
        : kit.data.parsed;
    const loaded = fieldsOf(parsed);
    if (!loaded) {
      setLoadError({ code: "KIT_NOT_FOUND", message: `No template named "${existing.name}" here.` });
      return;
    }
    setFields(loaded);
    setOriginal(loaded);
    setBaseHash(kit.data.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit.data]);

  const folderDecks = (workspace.data?.decks ?? []).filter((deck) => deck.kind === "folder" && !deck.error);
  const previewDeck = existing?.scope === "deck" ? existing.deckId : toDeck && deckId ? deckId : undefined;

  useEffect(() => {
    if (!fields) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewKit(
        "template",
        { source: templateSource(fields), name: name || "preview", deckId: previewDeck },
        controller.signal,
      ).then(
        (response) => {
          setPreviewErrors(response.errors);
          if (response.html) setHtml(response.html);
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setPreviewErrors([asApiError(reason).message]);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fields, name, previewDeck]);

  const dirty = existing
    ? Boolean(fields && original && JSON.stringify(fields) !== JSON.stringify(original))
    : name !== "" || JSON.stringify(fields) !== JSON.stringify(DEFAULT);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  if (existing && (kit.isPending || (!fields && !loadError)))
    return <Shell crumb="Templates">Loading template…</Shell>;
  if (kit.isError || loadError) {
    return (
      <Shell crumb={<Link to="/kits/templates">Templates</Link>}>
        <ErrorNotice error={loadError ?? asApiError(kit.error)} />
      </Shell>
    );
  }
  const current = fields!;
  const update = (patch: Partial<TemplateFields>) => setFields({ ...current, ...patch });

  const reason =
    regionProblem(current) ??
    (existing ? null : nameProblem(name)) ??
    (!existing && !toLibrary && !toDeck ? "Choose where to save: library, deck or both." : null) ??
    (!existing && toDeck && !deckId ? "Pick a deck." : null) ??
    (existing && !dirty ? "No changes to save." : null);

  const save = async () => {
    setSaving(true);
    setOutcomes([]);
    const jobs: { scope: string; run: () => Promise<KitDoc> }[] = [];
    if (existing?.scope === "library") {
      jobs.push({
        scope: "Library",
        run: () =>
          updateKit("template", name, {
            scope: "library",
            baseHash,
            patch: templatePatch(original, current),
          }),
      });
    } else if (existing?.scope === "deck") {
      jobs.push({
        scope: "Deck",
        run: async () => {
          const entry = await deckEntry(name, existing.deckId!);
          return updateKit("template", name, {
            scope: "deck",
            deckId: existing.deckId,
            baseHash: entry.hash,
            patch: templatePatch(entry.fields, current),
          });
        },
      });
    } else {
      if (toLibrary) {
        jobs.push({
          scope: "Library",
          run: () => createKit("template", { name, scope: "library", source: templateSource(current) }),
        });
      }
      if (toDeck) {
        jobs.push({
          scope: "Deck",
          run: async () => {
            const entry = await deckEntry(name, deckId);
            return updateKit("template", name, {
              scope: "deck",
              deckId,
              baseHash: entry.hash,
              patch: templatePatch(entry.fields, current),
            });
          },
        });
      }
    }
    // Both scopes are separate writes: report each, and keep whichever succeeded.
    const settled = await Promise.allSettled(jobs.map((job) => job.run()));
    const results = settled.map((result, index) => ({
      scope: jobs[index]!.scope,
      ok: result.status === "fulfilled",
      message: result.status === "fulfilled" ? "Saved." : asApiError(result.reason).message,
    }));
    setSaving(false);
    setOutcomes(results);
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    void queryClient.invalidateQueries({ queryKey: ["kit", "template"] });
    void queryClient.invalidateQueries({ queryKey: ["deck"] });
    const firstOk = settled.findIndex((result) => result.status === "fulfilled");
    if (firstOk === -1) return;
    const doc = (settled[firstOk] as PromiseFulfilledResult<KitDoc>).value;
    if (existing) {
      setOriginal(current);
      setBaseHash(doc.hash);
    } else if (results.every((result) => result.ok)) {
      leaving.current = true;
      navigate(templatePath(jobs[firstOk]!.scope === "Library" ? "library" : "deck", name, deckId));
    }
  };

  return (
    <Shell
      crumb={
        <>
          <Link to="/kits/templates">Templates</Link> · {existing ? existing.name : "New template"}
        </>
      }
      actions={
        <>
          {!existing ? <DraftKitButton kind="template" /> : null}
          {draft && dirty ? <span className="muted">Unsaved draft</span> : null}
          {reason && (existing ? dirty : true) ? (
            <span className="muted" data-testid="save-reason">
              {reason}
            </span>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={Boolean(reason) || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <h1>{existing ? existing.name : "New template"}</h1>
      {outcomes.length ? (
        <ul className="outcomes" data-testid="save-outcomes" aria-live="polite">
          {outcomes.map((outcome) => (
            <li key={outcome.scope} className={outcome.ok ? "ok" : "failed"}>
              <strong>{outcome.scope}:</strong> {outcome.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="template-editor">
        <section className="template-form">
          {!existing ? (
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value.trim())}
                aria-invalid={name && nameProblem(name) ? "true" : undefined}
              />
            </label>
          ) : null}
          <div className="field">
            <span>Region</span>
            <GridEditor value={current} onChange={(region) => update(region)} />
          </div>
          <div className="region-fields">
            {(["column", "row", "width", "height"] as const).map((key) => (
              <label key={key} className="field">
                <span>{key[0]!.toUpperCase() + key.slice(1)}</span>
                <input
                  type="number"
                  min={1}
                  max={3}
                  value={Number.isFinite(current[key]) ? current[key] : ""}
                  onChange={(event) => update({ [key]: Number(event.target.value) })}
                />
              </label>
            ))}
          </div>
          <fieldset className="field">
            <legend>Alignment</legend>
            <div className="segmented">
              {(["start", "center", "end"] as const).map((align) => (
                <label key={align} className="choice">
                  <input
                    type="radio"
                    name="align"
                    checked={current.align === align}
                    onChange={() => update({ align })}
                  />
                  {align}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>Role (optional)</span>
            <select
              value={current.role ?? ""}
              onChange={(event) => update({ role: event.target.value || null })}
            >
              <option value="">None</option>
              {ROLES.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Layout (optional)</span>
            <select
              value={current.layout ?? ""}
              onChange={(event) => update({ layout: event.target.value || null })}
            >
              <option value="">None</option>
              {LAYOUTS.map((layout) => (
                <option key={layout}>{layout}</option>
              ))}
            </select>
          </label>
          {!existing ? (
            <fieldset className="field">
              <legend>Save to</legend>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={toLibrary}
                  onChange={(event) => setToLibrary(event.target.checked)}
                />
                Library (~/Documents/flipbook/templates)
              </label>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={toDeck}
                  onChange={(event) => setToDeck(event.target.checked)}
                />
                A deck's templates.yml
              </label>
              {toDeck ? (
                <select aria-label="Deck" value={deckId} onChange={(event) => setDeckId(event.target.value)}>
                  <option value="">Pick a folder deck…</option>
                  {folderDecks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.title}
                    </option>
                  ))}
                </select>
              ) : null}
            </fieldset>
          ) : (
            <p className="muted">
              Saved in {existing.scope === "deck" ? "the deck's templates.yml" : "the library"}.
            </p>
          )}
        </section>
        <section className="theme-preview" aria-label="Template preview">
          {previewErrors.length ? (
            <p className="warning" role="status">
              {previewErrors.join(" ")}
            </p>
          ) : null}
          {html ? (
            <iframe title="Template preview" sandbox="" srcDoc={html} data-testid="template-preview" />
          ) : (
            <p>Rendering preview…</p>
          )}
        </section>
      </div>
      {blocker.state === "blocked" ? (
        <dialog open className="dialog" aria-labelledby="leave-title">
          <h2 id="leave-title">Leave without saving?</h2>
          <p>Your template changes are not saved.</p>
          <div className="actions">
            <button type="button" className="danger" onClick={() => blocker.proceed()}>
              Discard changes
            </button>
            <button type="button" onClick={() => blocker.reset()}>
              Stay
            </button>
          </div>
        </dialog>
      ) : null}
    </Shell>
  );
}
