import { useEffect, useRef, useState } from "react";
import type {
  AiProvider,
  ApiError,
  ApplyProposalResponse,
  Proposal,
  RewriteInstruction,
} from "../../shared/api";
import { ApiRequestError, rewriteSlide } from "../api";
import { AiAction, NO_RUN_USAGE, SendsTo, UsageNote, endUsage, trackUsage, type RunUsage } from "../ai";
import { ProposalReview } from "./ProposalReview";
import { ErrorNotice } from "./Shell";

const LANGUAGES = ["English", "Portuguese", "Spanish", "French", "German", "Italian", "Japanese", "Chinese"];

type Run =
  | { state: "idle" }
  | { state: "running"; text: string; notice: string | null }
  | { state: "review"; proposal: Proposal; notice: string | null }
  | { state: "noChange" }
  | { state: "failed"; error: ApiError; raw: string };

/**
 * The slide editor's AI menu (US-12): Shorten, Expand, Translate, Custom. It streams the model's
 * answer, then shows the proposal for review. The editor stays usable the whole time.
 */
export function AiPanel({
  deckId,
  slideId,
  baseHash,
  dirty,
  onApplied,
}: {
  deckId: string;
  slideId: string;
  baseHash: string;
  /** Unsaved edits: rewriting waits until they are saved. */
  dirty: boolean;
  onApplied: (result: ApplyProposalResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(LANGUAGES[0]!);
  const [custom, setCustom] = useState("");
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [showRaw, setShowRaw] = useState(false);
  // US-24: where the running rewrite sends the slide, from its `start` event.
  const [sendsTo, setSendsTo] = useState<AiProvider | null>(null);
  // US-25: the tokens of the last paid run, shown once it ends (also after Cancel).
  const [usage, setUsage] = useState<RunUsage>(NO_RUN_USAGE);
  const last = useRef<RewriteInstruction | null>(null);
  const controller = useRef<AbortController | null>(null);

  // Leaving the slide cancels a running rewrite.
  useEffect(() => () => controller.current?.abort(), [slideId]);

  const start = async (instruction: RewriteInstruction, avoid?: string[]) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    last.current = instruction;
    setOpen(false);
    setShowRaw(false);
    setSendsTo(null);
    setUsage(NO_RUN_USAGE);
    let text = "";
    let notice: string | null = null;
    setRun({ state: "running", text, notice });
    try {
      await rewriteSlide(
        { deckId, slideId, baseHash, instruction, ...(avoid?.length ? { avoid } : {}) },
        (aiEvent) => {
          if (abort.signal.aborted) return;
          setUsage((current) => trackUsage(current, aiEvent));
          const { event, data } = aiEvent;
          if (event === "start") setSendsTo(data.provider);
          else if (event === "token") {
            text += data.text;
            setRun({ state: "running", text, notice });
          } else if (event === "notice") {
            notice = data.message;
            setRun({ state: "running", text, notice });
          } else if (event === "proposal") setRun({ state: "review", proposal: data, notice });
          else if (event === "done" && data?.noChange) setRun({ state: "noChange" });
          else if (event === "failed") setRun({ state: "failed", error: data.error, raw: text });
        },
        abort.signal,
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      setRun({
        state: "failed",
        error: error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) },
        raw: text,
      });
    }
  };

  const cancel = () => {
    controller.current?.abort();
    setUsage(endUsage);
    setRun({ state: "idle" });
  };
  const raw = run.state === "failed" ? ((run.error.details?.raw as string | undefined) ?? run.raw) : "";
  const running = run.state === "running";

  return (
    <div className="ai-panel">
      <AiAction
        task="rewrite"
        onClick={() => setOpen((value) => !value)}
        disabled={dirty || running}
        title={dirty ? "Save your edits first." : "Rewrite this slide with AI"}
      >
        AI
      </AiAction>
      {dirty && !running ? <small className="muted">Save your edits to use AI.</small> : null}
      {running ? null : <UsageNote run={usage} />}
      {open ? (
        <div className="popover ai-menu" role="menu" aria-label="AI rewrite">
          <button type="button" role="menuitem" onClick={() => void start({ kind: "shorten" })}>
            Shorten
          </button>
          <button type="button" role="menuitem" onClick={() => void start({ kind: "expand" })}>
            Expand
          </button>
          <div className="ai-row">
            <select
              aria-label="Language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {LANGUAGES.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            <button type="button" role="menuitem" onClick={() => void start({ kind: "translate", language })}>
              Translate
            </button>
          </div>
          <form
            className="ai-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (custom.trim()) void start({ kind: "custom", text: custom.trim() });
            }}
          >
            <input
              aria-label="Custom instruction"
              placeholder="Custom… e.g. make it punchier"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
            <button type="submit" role="menuitem" disabled={!custom.trim()}>
              Rewrite
            </button>
          </form>
        </div>
      ) : null}

      {run.state !== "idle" ? (
        <section className="ai-result" aria-label="AI" data-testid="ai-panel">
          {"notice" in run && run.notice ? <p className="muted">{run.notice}</p> : null}
          {run.state === "running" ? (
            <>
              <p className="status">Asking the model…</p>
              <SendsTo provider={sendsTo} />
              <pre className="ai-tokens" data-testid="ai-tokens">
                {run.text}
              </pre>
              <button type="button" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : null}
          {run.state === "noChange" ? (
            <p role="status">
              No changes — the model kept the slide as it is.{" "}
              <button type="button" onClick={() => setRun({ state: "idle" })}>
                OK
              </button>
            </p>
          ) : null}
          {run.state === "failed" ? (
            <div data-testid="ai-error">
              <ErrorNotice error={run.error} />
              <p className="muted">The slide was not changed.</p>
              <span className="op-buttons">
                <button type="button" onClick={() => last.current && void start(last.current)}>
                  Retry
                </button>
                {raw ? (
                  <button type="button" onClick={() => setShowRaw((value) => !value)}>
                    {showRaw ? "Hide raw" : "Show raw"}
                  </button>
                ) : null}
                <button type="button" onClick={() => setRun({ state: "idle" })}>
                  Dismiss
                </button>
              </span>
              {showRaw ? <pre className="ai-tokens">{raw}</pre> : null}
            </div>
          ) : null}
          {run.state === "review" ? (
            <ProposalReview
              key={run.proposal.id}
              proposal={run.proposal}
              onApplied={onApplied}
              onRetry={(violations) =>
                last.current &&
                void start(
                  last.current,
                  violations.map((violation) => violation.message),
                )
              }
              onClose={() => setRun({ state: "idle" })}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
