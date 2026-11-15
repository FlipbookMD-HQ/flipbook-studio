import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, type Location } from "react-router-dom";
import type { ApiError, KitKind, Proposal, ProposalOp } from "../../shared/api";
import { ApiRequestError, discardProposal, draftKit } from "../api";
import { AiAction } from "../ai";
import { ProposalReview } from "./ProposalReview";
import { ErrorNotice } from "./Shell";

/** A drafted kit file handed to an editor through router state: shown there unsaved. */
export interface KitDraft {
  name: string;
  source: string;
}

/** The draft in a location's state, if the editor was opened with one. */
export const kitDraftOf = (location: Location): KitDraft | null =>
  (location.state as { draft?: KitDraft } | null)?.draft ?? null;

const LABELS: Record<KitKind, string> = {
  theme: "theme",
  template: "template",
  blueprint: "blueprint",
  group: "media kit",
};
const NAME_HINTS: Record<KitKind, { pattern: string; title: string }> = {
  theme: { pattern: "[a-z0-9-]{1,60}", title: "Lowercase letters, digits and dashes" },
  template: {
    pattern: "[a-z][a-z0-9_-]{0,59}",
    title: "Lowercase letters, digits, - or _, starting with a letter",
  },
  blueprint: {
    pattern: "[a-z][a-z0-9_-]{0,59}",
    title: "Lowercase letters, digits, - or _, starting with a letter",
  },
  group: {
    pattern: "[a-z][a-z0-9_-]{0,59}",
    title: "Lowercase letters, digits, - or _, starting with a letter",
  },
};
const PLACEHOLDERS: Record<KitKind, string> = {
  theme: "e.g. warm sand background, dark brown text, terracotta accents, a serif for headings",
  template: "e.g. a wide band across the top third, text aligned left",
  blueprint: "e.g. a cover, three to six points with at most four bullets, then a closing slide",
  group: "e.g. quarterly report decks: calm colours, a cover, one chart slide per metric, a summary",
};

/** Where an editor opens a single-file draft. */
function editorPath(kind: KitKind, deckId?: string): string {
  if (kind === "theme") return "/kits/themes/new";
  if (kind === "template") return "/kits/templates/new";
  if (kind === "blueprint")
    return deckId ? `/kits/blueprints/deck/${encodeURIComponent(deckId)}` : "/kits/blueprints/new";
  return "/kits/media/new";
}

type Run =
  | { state: "form" }
  | { state: "running"; text: string; notice: string | null }
  | { state: "review"; proposal: Proposal }
  | { state: "failed"; error: ApiError; raw: string };

/**
 * Draft with AI (US-14): a name and a description, then the model drafts the kit piece. A theme,
 * template or blueprint opens in its editor unsaved; a media kit shows its files for review, and
 * Accept all writes them and opens the kit. Nothing reaches the disk before the author saves.
 */
export function DraftKitButton({ kind, deckId }: { kind: KitKind; deckId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <AiAction
        task="draft"
        onClick={() => setOpen(true)}
        title={`Draft a ${LABELS[kind]} from a description`}
      >
        Draft with AI
      </AiAction>
      {open ? <DraftKitDialog kind={kind} deckId={deckId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DraftKitDialog({ kind, deckId, onClose }: { kind: KitKind; deckId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fixedName = Boolean(deckId);
  const [name, setName] = useState(fixedName ? "blueprint" : "");
  const [description, setDescription] = useState("");
  const [run, setRun] = useState<Run>({ state: "form" });
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => controller.current?.abort();
  }, []);

  const start = async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setShowRaw(false);
    let text = "";
    let notice: string | null = null;
    setRun({ state: "running", text, notice });
    const fail = (error: ApiError) => setRun({ state: "failed", error, raw: text });
    try {
      await draftKit(
        { kind, name, description, ...(deckId ? { deckId } : {}) },
        ({ event, data }) => {
          if (abort.signal.aborted) return;
          if (event === "token") {
            text += data.text;
            setRun({ state: "running", text, notice });
          } else if (event === "notice") {
            notice = data.message;
            setRun({ state: "running", text, notice });
          } else if (event === "proposal") {
            if (kind === "group") return setRun({ state: "review", proposal: data });
            // A single file opens in its editor, unsaved: the editor's own Save writes it.
            const op = data.ops[0] as Extract<ProposalOp, { kind: "writeKitFile" }>;
            void discardProposal(data.id);
            controller.current = null;
            onClose();
            navigate(editorPath(kind, deckId), { state: { draft: { name, source: op.source } } });
          } else if (event === "failed") fail(data.error);
        },
        abort.signal,
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      fail(error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) });
    }
  };

  const close = () => {
    controller.current?.abort();
    dialog.current?.close();
  };
  const raw = run.state === "failed" ? ((run.error.details?.raw as string | undefined) ?? run.raw) : "";
  const label = LABELS[kind];

  return (
    <dialog ref={dialog} className="dialog wide" aria-labelledby="draft-kit-title" onClose={onClose}>
      <h2 id="draft-kit-title">Draft a {label} with AI</h2>
      {run.state === "review" ? (
        <ProposalReview
          proposal={run.proposal}
          onApplied={(result) => {
            void queryClient.invalidateQueries({ queryKey: ["workspace"] });
            void queryClient.invalidateQueries({ queryKey: ["kit"] });
            if (result.applied.includes("op-1")) {
              dialog.current?.close();
              navigate(`/kits/media/library/${encodeURIComponent(name)}`);
            }
          }}
          onClose={close}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <fieldset disabled={run.state === "running"} className="plain">
            {fixedName ? (
              <p className="muted">Drafts this deck&apos;s blueprint.yml.</p>
            ) : (
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value.trim())}
                  required
                  {...NAME_HINTS[kind]}
                />
              </label>
            )}
            <label className="field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={PLACEHOLDERS[kind]}
                rows={4}
                maxLength={4000}
                required
              />
            </label>
          </fieldset>
          {run.state === "running" ? (
            <div aria-live="polite">
              <p className="muted" data-testid="draft-status">
                {run.notice ?? `Drafting the ${label}…`}
              </p>
              {run.text ? (
                <pre className="ai-tokens" data-testid="ai-tokens">
                  {run.text}
                </pre>
              ) : null}
            </div>
          ) : null}
          {run.state === "failed" ? (
            <div data-testid="draft-failed">
              <ErrorNotice error={run.error} />
              <p className="muted">Nothing was written.</p>
              {raw ? (
                <button type="button" onClick={() => setShowRaw((value) => !value)}>
                  {showRaw ? "Hide raw" : "Show raw"}
                </button>
              ) : null}
              {showRaw ? <pre className="ai-tokens">{raw}</pre> : null}
            </div>
          ) : null}
          <div className="actions">
            {run.state === "running" ? (
              <button
                type="button"
                onClick={() => {
                  controller.current?.abort();
                  setRun({ state: "form" });
                }}
              >
                Cancel
              </button>
            ) : (
              <button type="submit" className="primary">
                {run.state === "failed" ? "Retry" : "Draft"}
              </button>
            )}
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
