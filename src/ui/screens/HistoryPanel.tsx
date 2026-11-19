import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitAuthorSchema,
  VERSION_NOTE_MAX,
  type ApiError,
  type GitAuthor,
  type HistoryState,
  type RestoreResponse,
  type SlideRestoreResponse,
  type Version,
} from "../../shared/api";
import {
  ApiRequestError,
  discardDeck,
  getDeck,
  getVersions,
  getWorkspace,
  initGit,
  putSettings,
  restoreDeck,
  saveVersion,
} from "../api";
import { DECK_WRITTEN } from "../undo";
import { ErrorNotice } from "./Shell";
import { assetsKey } from "./ImagesPanel";
import { VersionView } from "./VersionView";

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
  onRestore,
  restoreBlocked,
  onView,
}: {
  versions: Version[];
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  /** US-26: Restore deck on each entry (left out when not given). */
  onRestore?: (version: Version) => void;
  /** Why Restore deck is disabled right now (unsaved edits, busy), if it is. */
  restoreBlocked?: string | null;
  /** US-27: opens the version's slides (left out when not given). */
  onView?: (version: Version) => void;
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
            {onView ? (
              <button
                type="button"
                className="history-restore"
                aria-label={`View slides of ${version.note}`}
                onClick={() => onView(version)}
              >
                View slides
              </button>
            ) : null}
            {onRestore ? (
              <button
                type="button"
                className="history-restore"
                disabled={Boolean(restoreBlocked)}
                title={restoreBlocked ?? `Put the whole deck back to “${version.note}”`}
                aria-label={`Restore deck to ${version.note}`}
                onClick={() => onRestore(version)}
              >
                Restore deck
              </button>
            ) : null}
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

// US-26: Restore deck.

/** The files Discard deletes: the deck's new files (git status "added"; ignored files never show). */
export function discardDeletes(history: HistoryState): string[] {
  return history.changes.filter((change) => change.status === "added").map((change) => change.path);
}

/** Asks before a whole-deck restore, saying what it does and doesn't do. */
export function RestoreConfirm({
  version,
  busy,
  onConfirm,
  onCancel,
}: {
  version: Version;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="history-offer" role="alertdialog" aria-label="Restore deck" data-testid="restore-confirm">
      <p>
        Restore the whole deck to <strong>“{version.note}”</strong>? Its slides and images become exactly what
        they were in that version. No commit is made and no version is deleted; you can undo it.
      </p>
      <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
        Restore
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** The deck has changes since its last version: save them, discard them, or stop. */
export function DirtyDialog({
  version,
  history,
  busy,
  onSave,
  onDiscard,
  onCancel,
}: {
  version: Version;
  history: HistoryState;
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const deletes = discardDeletes(history);
  const count = history.changes.length;
  return (
    <div
      className="history-offer"
      role="alertdialog"
      aria-label="Unsaved version changes"
      data-testid="restore-dirty"
    >
      <p>
        The deck has {count} {count === 1 ? "change" : "changes"} since{" "}
        {history.head ? `“${history.head.note}”` : "its last version"}. Before restoring “{version.note}”:
      </p>
      <button type="button" className="primary" disabled={busy} onClick={onSave}>
        Save version first
      </button>
      <button type="button" className="danger" disabled={busy} onClick={onDiscard}>
        Discard my changes
      </button>
      {deletes.length ? (
        <div className="muted" data-testid="discard-deletes">
          Discard deletes {deletes.length === 1 ? "this new file" : `these ${deletes.length} new files`}:
          <ul>
            {deletes.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted" data-testid="discard-deletes">
          Discard deletes no files; it puts back the changed ones.
        </p>
      )}
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** The History button and its panel. `blocked` disables Restore deck (unsaved edits). */
export function HistoryControl({
  deckId,
  blocked,
  onRestored,
  onSlideRestored,
}: {
  deckId: string;
  blocked?: string | null;
  onRestored?: (result: RestoreResponse) => void;
  /** US-27: after Restore this slide. */
  onSlideRestored?: (result: SlideRestoreResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="history-control">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        History
      </button>
      {open ? (
        <HistoryPanel
          deckId={deckId}
          blocked={blocked}
          onRestored={onRestored}
          onSlideRestored={onSlideRestored}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

export function HistoryPanel({
  deckId,
  onClose,
  blocked: editsBlocked = null,
  onRestored,
  onSlideRestored,
}: {
  deckId: string;
  onClose: () => void;
  blocked?: string | null;
  onRestored?: (result: RestoreResponse) => void;
  onSlideRestored?: (result: SlideRestoreResponse) => void;
}) {
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
  // US-26: the restore being confirmed, and which question is showing.
  const [pending, setPending] = useState<{ version: Version; step: "confirm" | "dirty" } | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  // US-27: the version whose slides are open.
  const [viewing, setViewing] = useState<Version | null>(null);

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

  const applyRestored = (result: RestoreResponse) => {
    queryClient.setQueryData(["deck", deckId], result.deck);
    queryClient.setQueryData(["history", deckId], result.history);
    for (const queryKey of [versionsKey(deckId), assetsKey(deckId), ["workspace"]])
      void queryClient.invalidateQueries({ queryKey });
    onRestored?.(result);
  };

  /** US-27: one slide came back from a version; the deck, undo label and images changed. */
  const applySlideRestored = (result: SlideRestoreResponse) => {
    queryClient.setQueryData(["deck", deckId], result.deck);
    queryClient.setQueryData(["history", deckId], result.history);
    for (const queryKey of [versionsKey(deckId), assetsKey(deckId), ["workspace"]])
      void queryClient.invalidateQueries({ queryKey });
    onSlideRestored?.(result);
  };

  const restore = async (version: Version, expectHead: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await restoreDeck(deckId, version.sha, expectHead);
      setPending(null);
      setRestored(version.note);
      applyRestored(result);
    } catch (caught) {
      const apiError = asApiError(caught);
      if (apiError.code === "DECK_DIRTY") setPending({ version, step: "dirty" });
      else {
        setPending(null);
        setError(apiError);
      }
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const startRestore = (version: Version) => {
    if (!history || editsBlocked) return;
    setError(null);
    setSaved(null);
    setRestored(null);
    setPending({ version, step: history.dirty ? "dirty" : "confirm" });
  };

  /** Save version first, then restore on top of the new version. */
  const saveThenRestore = async (version: Version) => {
    setBusy(true);
    setError(null);
    let head: string;
    try {
      head = (await saveVersion(deckId, note.trim())).version.sha;
      setNote("");
    } catch (caught) {
      const apiError = asApiError(caught);
      setPending(null);
      if (apiError.code === "GIT_AUTHOR_MISSING") setNeedsAuthor(true);
      else setError(apiError);
      setBusy(false);
      void refresh();
      return;
    }
    await refresh();
    await restore(version, head);
  };

  /** Discard my changes (back to the latest version), then restore. */
  const discardThenRestore = async (version: Version) => {
    const head = history?.head?.sha;
    if (!head) return;
    setBusy(true);
    setError(null);
    try {
      applyRestored(await discardDeck(deckId, head));
    } catch (caught) {
      setPending(null);
      setError(asApiError(caught));
      setBusy(false);
      void refresh();
      return;
    }
    await restore(version, head);
  };

  const disabled = history?.state === "no-git" || history?.state === "unsupported";
  const restoreBlocked = editsBlocked ?? (busy ? "Busy…" : null);
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
      {restored ? (
        <p className="notice" role="status" data-testid="history-restored">
          Restored “{restored}”. Undo puts the deck back.
        </p>
      ) : null}
      {editsBlocked && history?.state === "ready" ? (
        <p className="muted" data-testid="restore-blocked">
          Restore deck: {editsBlocked}
        </p>
      ) : null}
      {pending?.step === "confirm" ? (
        <RestoreConfirm
          version={pending.version}
          busy={busy}
          onConfirm={() => history?.head && void restore(pending.version, history.head.sha)}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending?.step === "dirty" && history ? (
        <DirtyDialog
          version={pending.version}
          history={history}
          busy={busy}
          onSave={() => void saveThenRestore(pending.version)}
          onDiscard={() => void discardThenRestore(pending.version)}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {history?.state === "ready" && viewing ? (
        <VersionView
          deckId={deckId}
          version={viewing}
          kind={deck.data?.kind ?? null}
          blocked={editsBlocked}
          onBack={() => setViewing(null)}
          onRestored={applySlideRestored}
        />
      ) : null}
      {history?.state === "ready" && !viewing ? (
        <Timeline
          versions={all}
          hasMore={Boolean(versions.hasNextPage)}
          loading={versions.isFetchingNextPage}
          onLoadMore={() => void versions.fetchNextPage()}
          onRestore={startRestore}
          restoreBlocked={restoreBlocked}
          onView={(version) => {
            setPending(null);
            setViewing(version);
          }}
        />
      ) : null}
    </section>
  );
}
