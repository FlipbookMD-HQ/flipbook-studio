import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitAuthorSchema,
  VERSION_NOTE_MAX,
  type ApiError,
  type GitAuthor,
  type HistoryState,
  type Version,
} from "../../shared/api";
import {
  ApiRequestError,
  getDeck,
  getVersions,
  getWorkspace,
  initGit,
  putSettings,
  saveVersion,
} from "../api";
import { DECK_WRITTEN } from "../undo";
import { ErrorNotice } from "./Shell";

// US-23: Save version and the timeline, in the deck editor's top bar.

export const versionsKey = (deckId: string) => ["versions", deckId] as const;

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError
    ? error.error
    : { code: "INTERNAL", message: String((error as Error)?.message ?? error) };

/** Why Save version can't run now, or null. A deck with no repo can: the click offers `git init`. */
export function saveBlockedReason(history: HistoryState): string | null {
  if (history.state === "no-git" || history.state === "unsupported")
    return history.reason ?? "Version history isn't available for this deck.";
  if (history.state === "ready" && !history.dirty)
    return history.head ? `No changes since ${history.head.note}` : "No changes to save";
  return null;
}

export interface InitTarget {
  at: "deck" | "workspace";
  label: string;
  dir: string;
}

/** Where `git init` can run for this deck, with the folder it would create the repository in. */
export function initTargets(
  history: HistoryState,
  workspaceRoot: string | null,
  deck: { path: string; kind: "folder" | "single" } | null,
): InitTarget[] {
  if (history.state !== "no-repo" || !workspaceRoot) return [];
  const targets: InitTarget[] = [];
  if (history.canInit.deck && deck?.kind === "folder")
    targets.push({ at: "deck", label: "the deck's folder", dir: `${workspaceRoot}/${deck.path}` });
  if (history.canInit.workspace)
    targets.push({ at: "workspace", label: "the workspace", dir: workspaceRoot });
  return targets;
}

const slidesText = (count: number) =>
  count === 0 ? "No slides changed" : `${count} ${count === 1 ? "slide" : "slides"} changed`;

/** State messages: why History is off, where versions are saved, and a detached HEAD. */
export function HistoryStatus({ history }: { history: HistoryState }) {
  if (history.state === "no-git")
    return (
      <p className="notice history-off" role="status" data-testid="history-state">
        History is off: {history.reason} Everything else in Studio works without git.
      </p>
    );
  if (history.state === "unsupported")
    return (
      <p className="notice history-off" role="status" data-testid="history-state">
        History isn&apos;t available for this deck: {history.reason}
      </p>
    );
  if (history.state === "no-repo")
    return (
      <p className="muted" data-testid="history-state">
        This deck isn&apos;t in a git repository yet. Save version offers to set one up; nothing happens until
        you say yes.
      </p>
    );
  return (
    <p className="muted history-repo" data-testid="history-state">
      Versions are saved in <code data-testid="history-repo-root">{history.repoRoot}</code>
      {history.detached ? (
        <>
          {" "}
          <span className="tag danger" data-testid="history-detached" title="HEAD isn't on a branch">
            detached
          </span>
        </>
      ) : null}
    </p>
  );
}

/** The `git init` offer, naming the folder each choice would create the repository in. */
export function InitOffer({
  targets,
  busy,
  onInit,
  onCancel,
}: {
  targets: InitTarget[];
  busy?: boolean;
  onInit: (at: InitTarget["at"]) => void;
  onCancel: () => void;
}) {
  return (
    <div className="history-offer" role="group" aria-label="Set up git" data-testid="history-init-offer">
      <p>
        To save versions, Studio can run <code>git init</code> (no commit is made). Where should the
        repository be?
      </p>
      {targets.map((target) => (
        <button
          key={target.at}
          type="button"
          disabled={busy}
          onClick={() => onInit(target.at)}
          title={target.dir}
        >
          Set up git in {target.label}
          <small className="mono history-dir">{target.dir}</small>
        </button>
      ))}
      <button type="button" className="link" onClick={onCancel}>
        Not now
      </button>
    </div>
  );
}

/** An error, with git's output (hooks, signing) in a collapsible section. */
export function GitErrorNotice({ error }: { error: ApiError }) {
  const output = typeof error.details?.output === "string" ? error.details.output : "";
  return (
    <div data-testid="history-error">
      <ErrorNotice error={error} />
      {output ? (
        <details className="git-output">
          <summary>Git output</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** Asked once, when git config has no author; saved to Studio's settings (never to git config). */
export function AuthorForm({
  busy,
  error,
  onSubmit,
}: {
  busy?: boolean;
  error?: string | null;
  onSubmit: (author: GitAuthor) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  return (
    <form
      className="history-author"
      data-testid="history-author"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = GitAuthorSchema.safeParse({ name, email });
        if (!parsed.success) return setInvalid(parsed.error.issues[0]?.message ?? "Check the fields.");
        setInvalid(null);
        onSubmit(parsed.data);
      }}
    >
      <p>Git doesn&apos;t know who you are. Studio will save versions with this name and email.</p>
      <label className="field">
        <span>Name</span>
        <input value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          autoComplete="email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {invalid || error ? (
        <p className="error" role="alert">
          {invalid ?? error}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        Save author and version
      </button>
    </form>
  );
}

/** The timeline, newest first, with Load more while there are older versions. */
export function Timeline({
  versions,
  hasMore,
  loading,
  onLoadMore,
}: {
  versions: Version[];
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
}) {
  if (!versions.length) return <p className="muted">No versions yet.</p>;
  return (
    <>
      <ol className="history-timeline" aria-label="Versions">
        {versions.map((version) => (
          <li key={version.sha} data-testid="history-version">
            <strong className="history-note">{version.note}</strong>
            <span className="muted history-meta">
              <time dateTime={version.time}>{new Date(version.time).toLocaleString()}</time> ·{" "}
              {version.author} · {slidesText(version.slidesChanged)} · <code>{version.sha.slice(0, 7)}</code>
            </span>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <button type="button" onClick={onLoadMore} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

/** The History button and its panel. */
export function HistoryControl({ deckId }: { deckId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="history-control">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        History
      </button>
      {open ? <HistoryPanel deckId={deckId} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

export function HistoryPanel({ deckId, onClose }: { deckId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const versions = useInfiniteQuery({
    queryKey: versionsKey(deckId),
    queryFn: ({ pageParam }) => getVersions(deckId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const deck = useQuery({ queryKey: ["deck", deckId], queryFn: () => getDeck(deckId) });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(false);
  const [needsAuthor, setNeedsAuthor] = useState(false);
  const [authorError, setAuthorError] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Any deck write (or undo) can make the deck dirty again.
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: versionsKey(deckId) });
    window.addEventListener(DECK_WRITTEN, refresh);
    return () => window.removeEventListener(DECK_WRITTEN, refresh);
  }, [deckId, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: versionsKey(deckId) });
  const history = versions.data?.pages[0]?.history ?? null;
  const all = versions.data?.pages.flatMap((page) => page.versions) ?? [];
  const blocked = history ? saveBlockedReason(history) : "Loading…";
  const targets = history
    ? initTargets(
        history,
        workspace.data?.root ?? null,
        deck.data ? { path: deck.data.path, kind: deck.data.kind } : null,
      )
    : [];

  const save = async () => {
    if (!history || busy) return;
    if (history.state === "no-repo") return setOffer(true);
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await saveVersion(deckId, note.trim());
      setNote("");
      setNeedsAuthor(false);
      setSaved(result.version.note);
      await refresh();
    } catch (caught) {
      const apiError = asApiError(caught);
      if (apiError.code === "GIT_AUTHOR_MISSING") setNeedsAuthor(true);
      else setError(apiError);
      if (apiError.code === "NO_CHANGES" || apiError.code === "GIT_NOT_A_REPO") void refresh();
    } finally {
      setBusy(false);
    }
  };

  const init = async (at: InitTarget["at"]) => {
    setBusy(true);
    setError(null);
    try {
      await initGit(deckId, at);
      setOffer(false);
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const saveAuthor = async (author: GitAuthor) => {
    setBusy(true);
    setAuthorError(null);
    try {
      await putSettings({ git: { author } });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (caught) {
      setAuthorError(asApiError(caught).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await save();
  };

  const disabled = history?.state === "no-git" || history?.state === "unsupported";
  return (
    <section
      className={`popover history-panel${disabled ? " disabled" : ""}`}
      aria-label="Version history"
      data-testid="history-panel"
      data-state={history?.state ?? "loading"}
    >
      <header className="history-head">
        <h2>History</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {versions.isError ? <ErrorNotice error={asApiError(versions.error)} /> : null}
      {history ? <HistoryStatus history={history} /> : <p className="muted">Loading…</p>}

      <form
        className="history-save"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Note (optional)</span>
          <input
            value={note}
            maxLength={VERSION_NOTE_MAX}
            placeholder="What changed?"
            disabled={disabled || busy}
            onChange={(event) => setNote(event.target.value.replace(/[\r\n]/g, " "))}
          />
        </label>
        <button
          type="submit"
          className="primary"
          disabled={Boolean(blocked) || busy}
          title={blocked ?? undefined}
        >
          Save version
        </button>
        {blocked && history ? (
          <small className="muted" data-testid="history-save-blocked">
            {blocked}
          </small>
        ) : null}
      </form>
      {history?.state === "ready" && history.dirty ? (
        <p className="muted history-changes" data-testid="history-changes">
          {history.changes.length} {history.changes.length === 1 ? "file" : "files"} changed since{" "}
          {history.head ? `“${history.head.note}”` : "the start"}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status" data-testid="history-saved">
          Saved “{saved}”.
        </p>
      ) : null}
      {offer && history?.state === "no-repo" ? (
        <InitOffer
          targets={targets}
          busy={busy}
          onInit={(at) => void init(at)}
          onCancel={() => setOffer(false)}
        />
      ) : null}
      {needsAuthor ? (
        <AuthorForm busy={busy} error={authorError} onSubmit={(author) => void saveAuthor(author)} />
      ) : null}
      {error ? <GitErrorNotice error={error} /> : null}

      {history?.state === "ready" ? (
        <Timeline
          versions={all}
          hasMore={Boolean(versions.hasNextPage)}
          loading={versions.isFetchingNextPage}
          onLoadMore={() => void versions.fetchNextPage()}
        />
      ) : null}
    </section>
  );
}
