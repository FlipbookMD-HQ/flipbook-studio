import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import type { ApiError, KitDoc, KitScope } from "../../shared/api";
import {
  cssWarning,
  hexColor,
  isFontToken,
  parseTokens,
  replaceToken,
  type CssToken,
} from "../../shared/cssTokens";
import { ApiRequestError, createKit, getKit, previewKit, updateKit } from "../api";
import { CodeEditor } from "./MarkdownEditor";
import { ErrorNotice, Shell } from "./Shell";
import { themePath } from "./ThemesScreen";
import { DraftKitButton, kitDraftOf } from "./DraftKitDialog";

const FONTS = [
  "Inter, system-ui, sans-serif",
  "system-ui, sans-serif",
  "Georgia, serif",
  '"Helvetica Neue", Arial, sans-serif',
  '"IBM Plex Sans", sans-serif',
  '"JetBrains Mono", monospace',
];

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

function TokenField({ token, onChange }: { token: CssToken; onChange: (value: string) => void }) {
  const color = hexColor(token.value);
  const id = `token-${token.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <div className="token-row">
      <label htmlFor={id}>
        <code>{token.name}</code>
        {token.selector !== ":root" && token.selector !== ":host" ? (
          <span className="muted"> in {token.selector}</span>
        ) : null}
      </label>
      {color ? (
        <input
          type="color"
          aria-label={`${token.name} color`}
          value={color}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <span />
      )}
      <input
        id={id}
        value={token.value}
        list={isFontToken(token) ? "font-options" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SaveAsCopy({
  initial,
  source,
  onSaved,
  onClose,
}: {
  initial: string;
  source: string;
  onSaved: (doc: KitDoc) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initial);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const save = async () => {
    try {
      onSaved(await createKit("theme", { name, scope: "library", source }));
    } catch (reason) {
      setError(asApiError(reason));
    }
  };
  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="copy-title" onClose={onClose}>
      <h2 id="copy-title">Save as copy</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Name of the library theme</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={error ? "true" : undefined}
            pattern="[a-z0-9-]{1,60}"
            title="Lowercase letters, digits and dashes"
            required
          />
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="actions">
          <button type="submit" className="primary">
            Save copy
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Kits → Themes → one theme: Tokens and Raw CSS tabs over one source string, with live samples.
 * At /kits/themes/new it holds an AI draft (US-14), unsaved until Save creates the library theme.
 */
export function ThemeEditor() {
  const params = useParams();
  const creating = params.scope == null;
  const { scope: rawScope = "library", name = "" } = params;
  const location = useLocation();
  const draft = creating ? kitDraftOf(location) : null;
  const scope = (["library", "deck", "builtin"].includes(rawScope) ? rawScope : "library") as KitScope;
  // Deck themes are addressed by deck ID.
  const deckId = scope === "deck" ? name : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const kit = useQuery({
    queryKey: ["kit", "theme", scope, name],
    queryFn: () => getKit("theme", scope === "deck" ? "presentation" : name, scope, deckId),
    enabled: !creating,
  });
  const [newName, setNewName] = useState("");
  // Set just before navigating to a copy that holds the changes, so the leave guard lets it through.
  const leaving = useRef(false);
  const [source, setSource] = useState<string | null>(null);
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [tab, setTab] = useState<"tokens" | "raw">("tokens");
  const [html, setHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (kit.data) {
      setSource(kit.data.source);
      setBaseHash(kit.data.hash);
      setSaved(kit.data.source);
    }
  }, [kit.data]);
  // Each new draft (a new navigation) replaces the editor's content.
  useEffect(() => {
    if (!draft) return;
    leaving.current = false;
    setSource(draft.source);
    setNewName(draft.name);
    setSaved(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const warning = source == null ? null : cssWarning(source);
  // Debounced preview, latest request wins; a CSS warning keeps the last good preview.
  useEffect(() => {
    if (source == null || warning) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewKit(
        "theme",
        deckId ? { source, deckId } : { source, scope: scope === "builtin" ? "builtin" : "library" },
        controller.signal,
      ).then(
        (response) => {
          setHtml(response.html);
          setPreviewError(null);
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setPreviewError(asApiError(reason));
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, warning, deckId, scope]);

  const dirty = source != null && (creating || (saved != null && source !== saved));
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  const tokens = useMemo(() => (source == null ? [] : parseTokens(source)), [source]);

  if (creating && !draft) {
    return (
      <Shell crumb={<Link to="/kits/themes">Themes</Link>} actions={<DraftKitButton kind="theme" />}>
        <h1>New theme</h1>
        <p>Draft a theme with AI, or open a theme and save it as a copy.</p>
      </Shell>
    );
  }
  if ((!creating && kit.isPending) || source == null) return <Shell crumb="Themes">Loading theme…</Shell>;
  if (kit.isError) {
    return (
      <Shell crumb={<Link to="/kits/themes">Themes</Link>}>
        <ErrorNotice error={asApiError(kit.error)} />
      </Shell>
    );
  }
  const builtIn = kit.data?.builtIn ?? false;
  const usedBy = kit.data?.usedBy ?? [];
  const title = creating ? "New theme" : scope === "deck" ? "presentation.css" : name;
  const nameProblem = creating && !/^[a-z0-9-]{1,60}$/.test(newName);

  const save = async () => {
    if (builtIn) return setCopying(true);
    if (creating) {
      setSaving(true);
      setSaveError(null);
      try {
        const doc = await createKit("theme", { name: newName, scope: "library", source });
        leaving.current = true;
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
        navigate(themePath("library", doc.ref.name));
      } catch (reason) {
        setSaveError(asApiError(reason));
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const doc = await updateKit("theme", kit.data!.ref.name, {
        scope,
        deckId,
        baseHash: baseHash!,
        source,
      });
      setBaseHash(doc.hash);
      setSaved(doc.source);
      queryClient.setQueryData(["kit", "theme", scope, name], doc);
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    } catch (reason) {
      setSaveError(asApiError(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell
      crumb={
        <>
          <Link to="/kits/themes">Themes</Link> · {title}
        </>
      }
      actions={
        <>
          {builtIn ? <span className="badge badge-built-in">Built-in — save as copy</span> : null}
          {creating ? <DraftKitButton kind="theme" /> : null}
          {dirty ? <span className="muted">{creating ? "Unsaved draft" : "Unsaved changes"}</span> : null}
          {!builtIn && !creating ? (
            <button type="button" onClick={() => setCopying(true)}>
              Save as copy…
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={saving || (!dirty && !builtIn) || nameProblem}
          >
            {builtIn ? "Save as copy…" : saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <h1>{title}</h1>
      {usedBy.length ? (
        <p className="muted">
          Used by {usedBy.length} deck{usedBy.length === 1 ? "" : "s"} in this workspace.
        </p>
      ) : null}
      {creating ? (
        <label className="field">
          <span>Name of the library theme</span>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value.trim())}
            aria-invalid={nameProblem ? "true" : undefined}
            pattern="[a-z0-9-]{1,60}"
            title="Lowercase letters, digits and dashes"
          />
        </label>
      ) : null}
      {saveError ? <ErrorNotice error={saveError} /> : null}
      <div className="theme-editor">
        <section className="theme-source">
          <div role="tablist" className="tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "tokens"}
              onClick={() => setTab("tokens")}
            >
              Tokens
            </button>
            <button type="button" role="tab" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>
              Raw CSS
            </button>
          </div>
          {warning ? (
            <p className="warning" role="status" data-testid="css-warning">
              {warning} The preview shows the last good version; you can still save.
            </p>
          ) : null}
          {tab === "tokens" ? (
            tokens.length ? (
              <div className="tokens" role="tabpanel">
                {tokens.map((token) => (
                  <TokenField
                    key={token.id}
                    token={token}
                    onChange={(value) =>
                      setSource((current) =>
                        current == null ? current : replaceToken(current, token, value),
                      )
                    }
                  />
                ))}
                <datalist id="font-options">
                  {FONTS.map((font) => (
                    <option key={font} value={font} />
                  ))}
                </datalist>
              </div>
            ) : (
              <p role="tabpanel">
                This theme defines no custom properties (--name: value). Edit it in Raw CSS.
              </p>
            )
          ) : (
            <div role="tabpanel">
              <CodeEditor value={source} onChange={setSource} language="css" label="CSS" />
            </div>
          )}
        </section>
        <section className="theme-preview" aria-label="Sample slides">
          {previewError ? <ErrorNotice error={previewError} /> : null}
          {html ? (
            <iframe title="Theme preview" sandbox="" srcDoc={html} data-testid="theme-preview" />
          ) : (
            <p>Rendering samples…</p>
          )}
        </section>
      </div>
      {copying ? (
        <SaveAsCopy
          initial={`${scope === "deck" ? "deck" : name}-copy`}
          source={source}
          onClose={() => setCopying(false)}
          onSaved={(doc) => {
            setCopying(false);
            leaving.current = true;
            void queryClient.invalidateQueries({ queryKey: ["workspace"] });
            navigate(themePath("library", doc.ref.name));
          }}
        />
      ) : null}
      {blocker.state === "blocked" ? (
        <dialog open className="dialog" aria-labelledby="leave-title">
          <h2 id="leave-title">Leave without saving?</h2>
          <p>Your changes to this theme are not saved.</p>
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
