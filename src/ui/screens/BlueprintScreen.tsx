import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { parse } from "yaml";
import type { ApiError, Violation } from "../../shared/api";
import {
  STARTER,
  asBlueprint,
  blueprintProblems,
  blueprintYaml,
  mergeDiff,
  patchYaml,
  type Blueprint,
} from "../../shared/blueprintModel";
import { ApiRequestError, createKit, getDeck, getKit, getWorkspace, previewKit, updateKit } from "../api";
import { BlueprintEditor } from "./BlueprintEditor";
import { blueprintPath } from "./BlueprintsScreen";
import { DuplicateKitButton } from "./Duplicate";
import { DraftKitButton, kitDraftOf } from "./DraftKitDialog";
import { CodeEditor } from "./MarkdownEditor";
import { ErrorNotice, Shell } from "./Shell";

const BUILT_IN = ["flow", "cover", "summary"];
const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

function parseSource(source: string): { value: Blueprint | null; error: string | null } {
  try {
    const value = asBlueprint(parse(source));
    return value
      ? { value, error: null }
      : { value: null, error: "The blueprint must be a YAML mapping with pages and types." };
  } catch (error) {
    return { value: null, error: `Not valid YAML: ${(error as Error).message.split("\n")[0]}` };
  }
}

/** Kits → Blueprints → one blueprint: Form and Raw YAML tabs, and a live check against a deck. */
export function BlueprintScreen() {
  const { name: libraryName, deckId: routeDeck } = useParams();
  const scope = routeDeck ? ("deck" as const) : ("library" as const);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const kit = useQuery({
    queryKey: ["kit", "blueprint", scope, routeDeck ?? libraryName],
    queryFn: async () => {
      try {
        return await getKit("blueprint", libraryName ?? "blueprint", scope, routeDeck);
      } catch (error) {
        // A deck without blueprint.yml yet: start a new one.
        if (scope === "deck" && error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(libraryName || routeDeck),
  });
  const creating = !libraryName && (!routeDeck || kit.data === null);

  const [source, setSource] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ source: string; hash: string } | null>(null);
  const [rawEdited, setRawEdited] = useState(false);
  const [tab, setTab] = useState<"form" | "raw">("form");
  const [newName, setNewName] = useState("");
  const [checkDeck, setCheckDeck] = useState(routeDeck ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [affected, setAffected] = useState<Violation[] | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);
  const location = useLocation();
  const draft = creating ? kitDraftOf(location) : null;

  // An AI draft (US-14) opens unsaved; each new draft replaces the editor's content.
  useEffect(() => {
    if (!draft) return;
    leaving.current = false;
    setSource(draft.source);
    if (scope === "library") setNewName(draft.name);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, creating]);

  useEffect(() => {
    if (kit.data) {
      leaving.current = false;
      setSource(kit.data.source);
      setSaved({ source: kit.data.source, hash: kit.data.hash });
    } else if (creating && source == null && !draft) {
      setSource(blueprintYaml(STARTER));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit.data, creating]);

  const deck = useQuery({
    queryKey: ["deck", checkDeck],
    queryFn: () => getDeck(checkDeck),
    enabled: Boolean(checkDeck),
  });
  const templates = useMemo(() => {
    const names = new Set(BUILT_IN);
    for (const template of workspace.data?.library.templates ?? [])
      if (template.scope === "library") names.add(template.name);
    for (const template of deck.data?.templates ?? []) names.add(template);
    return [...names];
  }, [workspace.data, deck.data]);

  const parsed = source == null ? null : parseSource(source);
  // The deck check refreshes on each change (debounced, latest wins).
  useEffect(() => {
    if (source == null || parsed?.error) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewKit("blueprint", { source, deckId: checkDeck || undefined }, controller.signal).then(
        (response) => {
          setErrors(response.errors);
          setAffected(response.affectedSlides ?? null);
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setErrors([asApiError(reason).message]);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, checkDeck, parsed?.error]);

  const dirty = source != null && (creating ? true : source !== saved?.source);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current &&
      dirty &&
      (!creating || Boolean(draft)) &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  if (kit.isPending && !creating) return <Shell crumb="Blueprints">Loading blueprint…</Shell>;
  if (kit.isError) {
    return (
      <Shell crumb={<Link to="/kits/blueprints">Blueprints</Link>}>
        <ErrorNotice error={asApiError(kit.error)} />
      </Shell>
    );
  }
  if (source == null || !parsed) return <Shell crumb="Blueprints">Loading blueprint…</Shell>;

  const value = parsed.value;
  const problems = value ? blueprintProblems(value, new Set(templates)) : [];
  const deckTitle = workspace.data?.decks.find((item) => item.id === routeDeck)?.title ?? "deck";
  const title = scope === "deck" ? `${deckTitle} · blueprint.yml` : (libraryName ?? "New library blueprint");
  const reason =
    parsed.error ??
    problems[0]?.message ??
    errors[0] ??
    (creating && scope === "library" && !/^[a-z][a-z0-9_-]{0,59}$/.test(newName)
      ? "Name the blueprint (lowercase letters, digits, - or _)."
      : null) ??
    (!dirty ? "No changes to save." : null);

  const onForm = (next: Blueprint) => {
    const patch = mergeDiff(parse(source), next);
    if (Object.keys(patch).length) setSource(patchYaml(source, patch));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (creating) {
        const doc = await createKit("blueprint", {
          name: scope === "deck" ? "blueprint" : newName,
          scope,
          deckId: routeDeck,
          source,
        });
        leaving.current = true;
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
        void queryClient.invalidateQueries({ queryKey: ["kit", "blueprint"] });
        if (scope === "deck") {
          setSaved({ source: doc.source, hash: doc.hash });
          void queryClient.invalidateQueries({ queryKey: ["deck"] });
        } else navigate(blueprintPath("library", doc.ref.name));
        return;
      }
      // Form edits send a patch (comments elsewhere survive); raw edits send the text.
      const change = rawEdited ? { source } : { patch: mergeDiff(parse(saved!.source), parse(source)) };
      const doc = await updateKit("blueprint", libraryName ?? "blueprint", {
        scope,
        deckId: routeDeck,
        baseHash: saved!.hash,
        ...change,
      });
      setSaved({ source: doc.source, hash: doc.hash });
      setSource(doc.source);
      setRawEdited(false);
      void queryClient.invalidateQueries({ queryKey: ["deck"] });
    } catch (error) {
      setSaveError(asApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const decks = (workspace.data?.decks ?? []).filter((item) => !item.error);
  return (
    <Shell
      crumb={
        <>
          <Link to="/kits/blueprints">Blueprints</Link> · {title}
        </>
      }
      actions={
        <>
          {creating ? <DraftKitButton kind="blueprint" deckId={routeDeck} /> : null}
          {!creating && scope === "library" && libraryName ? (
            <DuplicateKitButton kind="blueprint" name={libraryName} scope="library" className="" />
          ) : null}
          {draft ? <span className="muted">Unsaved draft</span> : null}
          {reason && reason !== "No changes to save." ? (
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
      <h1>{title}</h1>
      {saveError ? <ErrorNotice error={saveError} /> : null}
      {creating && scope === "library" ? (
        <label className="field narrow">
          <span>Blueprint name</span>
          <input value={newName} onChange={(event) => setNewName(event.target.value.trim())} />
        </label>
      ) : null}
      <div className="blueprint-layout">
        <section>
          <div role="tablist" className="tabs">
            <button type="button" role="tab" aria-selected={tab === "form"} onClick={() => setTab("form")}>
              Form
            </button>
            <button type="button" role="tab" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>
              Raw YAML
            </button>
          </div>
          {tab === "form" ? (
            value ? (
              <BlueprintEditor value={value} onChange={onForm} templates={templates} problems={problems} />
            ) : (
              <p className="warning">{parsed.error} Fix it in the Raw YAML tab.</p>
            )
          ) : (
            <CodeEditor
              value={source}
              onChange={(next) => {
                setSource(next);
                setRawEdited(true);
              }}
              language="yaml"
              label="Blueprint YAML"
            />
          )}
        </section>
        <aside className="deck-check" aria-labelledby="check-title">
          <h2 id="check-title">Check against deck</h2>
          <select
            aria-label="Check against deck"
            value={checkDeck}
            onChange={(event) => setCheckDeck(event.target.value)}
            disabled={scope === "deck"}
          >
            <option value="">No deck</option>
            {decks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <div data-testid="deck-check" aria-live="polite">
            {errors.length ? (
              <ul className="inline-problems">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : affected == null ? (
              <p className="muted">Pick a deck to see which slides would fail.</p>
            ) : affected.length === 0 ? (
              <p className="ok">Every slide passes.</p>
            ) : (
              <>
                <p>{new Set(affected.map((item) => item.source)).size} slide(s) would fail:</p>
                <ul className="violations-list">
                  {affected.map((item) => (
                    <li key={item.message}>{item.message}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
      {blocker.state === "blocked" ? (
        <dialog open className="dialog" aria-labelledby="leave-title">
          <h2 id="leave-title">Leave without saving?</h2>
          <p>Your blueprint changes are not saved.</p>
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
