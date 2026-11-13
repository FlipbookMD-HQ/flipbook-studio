import { useState } from "react";
import type { ApiError, ApplyProposalResponse, Proposal, ProposalOp, Violation } from "../../shared/api";
import { ApiRequestError, applyProposal, discardProposal } from "../api";
import { DiffView } from "./DiffView";
import { ErrorNotice } from "./Shell";

type OpState = "pending" | "applied" | "rejected" | "stale" | "invalid";

const KIND_LABELS: Record<ProposalOp["kind"], string> = {
  updateSlide: "Slide edits",
  addSlide: "New slides",
  deleteSlide: "Deleted slides",
  moveSlide: "Moved slides",
  writeKitFile: "Kit files",
};
const GROUP_AT = 10;

function OpBody({ op }: { op: ProposalOp }) {
  switch (op.kind) {
    case "updateSlide":
      return (
        <>
          <DiffView before={op.before?.markdown ?? ""} after={op.draft.markdown} label="Slide" />
          {op.before && op.before.notes !== op.draft.notes ? (
            <DiffView before={op.before.notes} after={op.draft.notes} label="Speaker notes" />
          ) : null}
        </>
      );
    case "addSlide":
      return (
        <>
          <p>Adds a slide {op.afterSlideId ? `after ${op.afterSlideId}` : "at the start"}:</p>
          <pre className="op-text">{op.draft.markdown}</pre>
        </>
      );
    case "deleteSlide":
      return <p>Deletes {op.slideId}.</p>;
    case "moveSlide":
      return (
        <p>
          Moves {op.slideId} to position {op.toIndex + 1}.
        </p>
      );
    case "writeKitFile":
      return (
        <>
          <p>
            Writes the {op.kit.kind} {op.kit.name} ({op.kit.scope}).
          </p>
          <pre className="op-text">{op.source}</pre>
        </>
      );
  }
}

function opTitle(op: ProposalOp): string {
  return "slideId" in op ? `${KIND_LABELS[op.kind]}: ${op.slideId}` : KIND_LABELS[op.kind];
}

/**
 * Reviews an AI proposal: one card per op with accept and reject, and Accept all. Nothing is
 * written until an op is accepted. Shared by every AI feature (US-12 to US-15); it knows nothing
 * about routes: the caller reloads what changed in `onApplied`.
 */
export function ProposalReview({
  proposal,
  onApplied,
  onRetry,
  onClose,
  staleOpIds,
}: {
  proposal: Proposal;
  onApplied: (result: ApplyProposalResponse) => void;
  /** Ask again, telling the model which rules the proposal broke. */
  onRetry?: (violations: Violation[]) => void;
  onClose: () => void;
  /** Ops the caller knows are stale (their file changed since): shown stale, never applied. */
  staleOpIds?: ReadonlySet<string>;
}) {
  const [states, setStates] = useState<Record<string, OpState>>(() =>
    Object.fromEntries(proposal.ops.map((op) => [op.id, "pending" as OpState])),
  );
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const stateOf = (op: ProposalOp): OpState =>
    states[op.id] === "pending" && staleOpIds?.has(op.id) ? "stale" : states[op.id]!;
  const pending = proposal.ops.filter((op) => stateOf(op) === "pending");

  const accept = async (opIds: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await applyProposal(proposal.id, opIds);
      setStates((current) => {
        const next = { ...current };
        for (const id of result.applied) next[id] = "applied";
        for (const { opId, code } of result.rejected)
          next[opId] = code === "STALE_PROPOSAL" ? "stale" : "invalid";
        return next;
      });
      setMessages((current) => ({
        ...current,
        ...Object.fromEntries(result.rejected.map(({ opId, message }) => [opId, message])),
      }));
      onApplied(result);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.error : { code: "INTERNAL", message: String(caught) },
      );
    } finally {
      setBusy(false);
    }
  };
  const reject = (opId: string) => setStates((current) => ({ ...current, [opId]: "rejected" }));
  const close = () => {
    void discardProposal(proposal.id);
    onClose();
  };

  const card = (op: ProposalOp) => {
    const state = stateOf(op);
    const violations = op.kind === "updateSlide" ? (op.violations ?? []) : [];
    return (
      <article key={op.id} className={`op-card ${state}`} data-testid="op-card" data-state={state}>
        <header>
          <h3>{opTitle(op)}</h3>
          {state === "pending" ? (
            <span className="op-buttons">
              <button type="button" disabled={busy} onClick={() => reject(op.id)}>
                Reject
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void accept([op.id])}>
                Accept
              </button>
            </span>
          ) : (
            <span className="op-state">
              {state === "applied"
                ? "Accepted"
                : state === "rejected"
                  ? "Rejected"
                  : state === "stale"
                    ? "Stale — changed on disk"
                    : "Couldn't apply"}
            </span>
          )}
        </header>
        {violations.length ? (
          <div className="op-violations" role="alert" data-testid="op-violations">
            <p>This proposal breaks the blueprint:</p>
            <ul>
              {violations.map((violation, index) => (
                <li key={index}>{violation.message}</li>
              ))}
            </ul>
            {onRetry && state === "pending" ? (
              <button type="button" onClick={() => onRetry(violations)}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {messages[op.id] ? <p className="field-error">{messages[op.id]}</p> : null}
        <fieldset disabled={state === "stale"} className="op-body">
          <OpBody op={op} />
        </fieldset>
      </article>
    );
  };

  const grouped = proposal.ops.length >= GROUP_AT;
  const kinds = [...new Set(proposal.ops.map((op) => op.kind))];
  return (
    <section className="proposal" aria-label="AI proposal" data-testid="proposal">
      <header className="proposal-head">
        <h2>{proposal.summary}</h2>
        <span className="op-buttons">
          <button type="button" onClick={close}>
            {pending.length ? "Reject all" : "Close"}
          </button>
          {pending.length ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void accept(pending.map((op) => op.id))}
            >
              Accept all
            </button>
          ) : null}
        </span>
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      {grouped
        ? kinds.map((kind) => (
            <details key={kind} open className="op-group">
              <summary>
                {KIND_LABELS[kind]} ({proposal.ops.filter((op) => op.kind === kind).length})
              </summary>
              {proposal.ops.filter((op) => op.kind === kind).map(card)}
            </details>
          ))
        : proposal.ops.map(card)}
    </section>
  );
}
