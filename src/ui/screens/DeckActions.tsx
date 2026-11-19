import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiError,
  ExportJob,
  ExportRequest,
  ExportsInfo,
  RestoreResponse,
  SlideRestoreResponse,
  UndoResponse,
  Violation,
} from "../../shared/api";
import { ApiRequestError, cancelJob, followJob, getExports, presentDeck, startExport } from "../api";
import { ErrorNotice } from "./Shell";
import { UndoControls } from "./UndoControls";
import { HistoryControl } from "./HistoryPanel";

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

/** Opens a blank tab now (inside the click, so it isn't blocked) and returns it without an opener. */
function blankTab(): Window | null {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/** Undo, Redo, History, Present and Export for a deck, in the top bar. */
export function DeckActions({
  deckId,
  slideIndex,
  disabled,
  undoBlocked,
  onUndo,
  onRestored,
  onSlideRestored,
}: {
  deckId: string;
  slideIndex: number;
  disabled?: boolean;
  /** Why Undo and Redo are disabled right now (unsaved edits), if they are. */
  undoBlocked?: string | null;
  onUndo?: (result: UndoResponse) => void;
  /** US-26: after Restore deck or Discard changes rewrote the deck's files. */
  onRestored?: (result: RestoreResponse) => void;
  /** US-27: after Restore this slide put one slide back from a version. */
  onSlideRestored?: (result: SlideRestoreResponse) => void;
}) {
  const [presentError, setPresentError] = useState<ApiError | null>(null);
  const [announcerUrl, setAnnouncerUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const info = useQuery({ queryKey: ["exports", deckId], queryFn: () => getExports(deckId) });
  const running = info.data?.job?.state === "running" ? info.data.job : null;

  const present = async () => {
    setPresentError(null);
    const player = blankTab();
    const announcer = blankTab();
    try {
      const urls = await presentDeck(deckId, slideIndex);
      if (player) player.location.href = urls.url;
      else window.open(urls.url, "_blank", "noopener");
      if (announcer) announcer.location.href = urls.announcerUrl;
      // A browser that blocks the second tab gets a link instead.
      setAnnouncerUrl(announcer ? null : urls.announcerUrl);
    } catch (error) {
      player?.close();
      announcer?.close();
      setPresentError(asApiError(error));
    }
  };

  return (
    <>
      <UndoControls deckId={deckId} blocked={undoBlocked} onChanged={onUndo} />
      <HistoryControl
        deckId={deckId}
        blocked={undoBlocked}
        onRestored={onRestored}
        onSlideRestored={onSlideRestored}
      />
      <button type="button" onClick={present} disabled={disabled}>
        Present
      </button>
      <button type="button" className="primary" onClick={() => setExporting(true)} disabled={disabled}>
        {running ? `Exporting ${running.progress.done}/${running.progress.total}…` : "Export…"}
      </button>
      {announcerUrl ? (
        <a href={announcerUrl} target="_blank" rel="noopener noreferrer" className="announcer-link">
          Open announcer
        </a>
      ) : null}
      {presentError ? (
        <div className="popover" role="alert" data-testid="present-error">
          <ErrorNotice error={presentError} />
          <button type="button" onClick={() => setPresentError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {exporting && info.data ? (
        <ExportDialog deckId={deckId} info={info.data} onClose={() => setExporting(false)} />
      ) : null}
    </>
  );
}

function ViolationList({ violations }: { violations: Violation[] }) {
  return (
    <ul className="violations-list">
      {violations.map((violation, index) => (
        <li key={index}>
          <strong>{violation.source}</strong> {violation.message}
        </li>
      ))}
    </ul>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="install-command">
      <code data-testid="install-command">{command}</code>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ExportDialog({ deckId, info, onClose }: { deckId: string; info: ExportsInfo; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const { defaults } = info;
  const [preset, setPreset] = useState(info.job?.state === "running" ? info.job.preset : defaults.preset);
  const [format, setFormat] = useState<ExportRequest["format"]>(defaults.format);
  const [duration, setDuration] = useState(defaults.duration ?? 15);
  const folderFor = (name: string, kind: string) =>
    defaults.outputDir ?? `${defaults.outputBase}/${name}-${kind}`;
  const [outputDir, setOutputDir] = useState(folderFor(preset, format));
  const [folderEdited, setFolderEdited] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(info.job);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    if (!folderEdited) setOutputDir(folderFor(preset, format));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, format, folderEdited]);

  // Follows the running job; reopening the dialog (or the deck) reconnects and replays its state.
  const jobId = job?.state === "running" ? job.id : null;
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    followJob(
      jobId,
      (event) =>
        setJob((current) => {
          if (!current) return current;
          if (event.type === "progress")
            return { ...current, progress: { done: event.done, total: event.total } };
          if (event.type === "failed") return { ...current, state: "failed", error: event.error };
          return { ...current, state: event.type, outputDir: event.outputDir, files: event.files };
        }),
      controller.signal,
    )
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(asApiError(reason));
      })
      .finally(() => void queryClient.invalidateQueries({ queryKey: ["exports", deckId] }));
    return () => controller.abort();
  }, [jobId, deckId, queryClient]);

  const start = async () => {
    setError(null);
    const request: ExportRequest = { preset, format, outputDir, ...(format === "video" ? { duration } : {}) };
    try {
      const { jobId: id } = await startExport(deckId, request);
      setJob({
        id,
        deckId,
        preset,
        format,
        state: "running",
        progress: { done: 0, total: 0 },
        outputDir,
        files: [],
        error: null,
      });
      void queryClient.invalidateQueries({ queryKey: ["exports", deckId] });
    } catch (reason) {
      setError(asApiError(reason));
    }
  };

  const running = job?.state === "running";
  const violations = error?.code === "BLUEPRINT_FAILED" ? (error.details?.violations as Violation[]) : null;
  const installCommand =
    error?.code === "DEPENDENCY_MISSING" ? String(error.details?.installCommand ?? "") : null;
  const percent = job && job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;

  return (
    <dialog ref={dialog} className="dialog export-dialog" aria-labelledby="export-title" onClose={onClose}>
      <h2 id="export-title">Export</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label className="field">
          <span>Preset</span>
          <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={running}>
            {info.presets.map((option) => (
              <option key={option.name} value={option.name}>
                {option.name} — {option.width}×{option.height} ({option.use})
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Format</legend>
          <label className="choice">
            <input
              type="radio"
              name="format"
              checked={format === "png"}
              onChange={() => setFormat("png")}
              disabled={running}
            />
            PNG carousel
          </label>
          <label className="choice">
            <input
              type="radio"
              name="format"
              checked={format === "video"}
              onChange={() => setFormat("video")}
              disabled={running}
            />
            MP4 video
          </label>
        </fieldset>
        {format === "video" ? (
          <label className="field">
            <span>Duration (seconds)</span>
            <input
              type="number"
              min={1}
              max={1800}
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              disabled={running}
            />
          </label>
        ) : null}
        <label className="field">
          <span>Output folder (in the workspace)</span>
          <input
            value={outputDir}
            onChange={(event) => {
              setFolderEdited(true);
              setOutputDir(event.target.value);
            }}
            disabled={running}
          />
        </label>

        {job ? (
          <div className="export-status" data-testid="export-status" aria-live="polite">
            <progress max={100} value={percent} aria-label="Export progress" />
            <p>
              {job.state === "running" &&
                `Exporting slide ${job.progress.done} of ${job.progress.total || "…"}`}
              {job.state === "done" && `Done: ${job.files.length} files in ${job.outputDir}`}
              {job.state === "cancelled" && `Cancelled. ${job.files.length} files kept in ${job.outputDir}`}
            </p>
            {job.state === "failed" && job.error ? <ErrorNotice error={job.error} /> : null}
          </div>
        ) : null}

        {violations ? (
          <div className="error" role="alert" data-testid="export-blocked">
            <p>{error!.message}</p>
            <ViolationList violations={violations} />
          </div>
        ) : installCommand ? (
          <div className="error" role="alert" data-testid="export-dependency">
            <p>{error!.message.split(" Run:")[0]} Install it, then try again:</p>
            <CopyCommand command={installCommand} />
          </div>
        ) : error ? (
          <ErrorNotice error={error} />
        ) : null}

        <div className="actions">
          {running ? (
            <button
              type="button"
              className="danger"
              onClick={() => void cancelJob(job!.id).catch((reason) => setError(asApiError(reason)))}
            >
              Cancel export
            </button>
          ) : (
            <button type="submit" className="primary">
              {job ? "Export again" : "Start export"}
            </button>
          )}
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}
