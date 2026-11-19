import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { AiProvider, ApiError, GenerateDeckRequest, SlideDraft, Violation } from "../../shared/api";
import { ApiRequestError, generateDeck, getDeck, saveGeneratedDeck } from "../api";
import { NO_RUN_USAGE, SendsTo, UsageNote, trackUsage, useLlmStatus, type RunUsage } from "../ai";
import { ErrorNotice } from "./Shell";

type Status =
  | { state: "running" }
  | { state: "repairing"; round: number; count: number }
  | { state: "failed"; error: ApiError }
  | { state: "taken"; runId: string; error: ApiError };

/** The first line of a slide's Markdown without its # marks, for the slide cards. */
const heading = (draft: SlideDraft) =>
  (draft.markdown.split("\n").find((line) => line.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 80);

/** Router state a generation leaves on the deck it opens (US-25): its tokens, shown once. */
interface GeneratedState {
  generatedUsage?: RunUsage;
}

/**
 * Opens a new deck at its first failing slide, or at slide 1 (US-13, US-18). A generation passes
 * its usage so the deck can show what the run used, since its progress panel closes (US-25).
 */
export function useOpenDeck() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (deckId: string, violations: Violation[], generatedUsage?: RunUsage) => {
    await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    const deck = await getDeck(deckId);
    queryClient.setQueryData(["deck", deckId], deck);
    const sources = new Set(violations.map((violation) => violation.source));
    const target = deck.slides.find((slide) => sources.has(slide.source)) ?? deck.slides[0];
    const state: GeneratedState | undefined = generatedUsage ? { generatedUsage } : undefined;
    navigate(target ? `/decks/${deckId}/slides/${encodeURIComponent(target.id)}` : `/decks/${deckId}`, {
      state,
    });
  };
}

/** "Generated with <provider> · N in · M out tokens" on the deck a paid generation opened (US-25). */
export function GeneratedUsageNotice() {
  const run = (useLocation().state as GeneratedState | null)?.generatedUsage;
  if (!run?.provider || run.provider.kind === "local") return null;
  return (
    <div className="notice" role="status" data-testid="generated-usage">
      Generated with <strong>{run.provider.label}</strong> · <UsageNote run={{ ...run, ended: true }} />
    </div>
  );
}

/**
 * Runs one generation (US-13): slides appear as they stream in, then repair rounds; on done it
 * opens the deck at its first failing slide (or slide 1). The parent asks before cancelling.
 */
export function GenerateProgress({
  request,
  controller,
  onFinished,
}: {
  request: GenerateDeckRequest;
  controller: AbortController;
  /** The run ended without opening a deck (failed, cancelled): the form can be used again. */
  onFinished: () => void;
}) {
  const [slides, setSlides] = useState<SlideDraft[]>([]);
  const [status, setStatus] = useState<Status>({ state: "running" });
  const [saveAsName, setSaveAsName] = useState(`${request.name}-2`.slice(0, 60));
  const [saveAsError, setSaveAsError] = useState<ApiError | null>(null);
  // US-24: where the generation sends the topic or source, from its `start` event.
  const [sendsTo, setSendsTo] = useState<AiProvider | null>(null);
  // US-25: the run's tokens, shown when it stops here (failed, or its name taken).
  const [usage, setUsage] = useState<RunUsage>(NO_RUN_USAGE);
  // The same, read synchronously when the deck opens (state updates aren't applied yet).
  const usageRef = useRef<RunUsage>(NO_RUN_USAGE);
  const started = useRef(false);

  const open = useOpenDeck();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        await generateDeck(
          request,
          (aiEvent) => {
            usageRef.current = trackUsage(usageRef.current, aiEvent);
            setUsage(usageRef.current);
            const { event, data } = aiEvent;
            if (event === "start") setSendsTo(data.provider);
            else if (event === "slide") setSlides((current) => [...current, data.draft]);
            else if (event === "repair") {
              const count = new Set(data.violations.map((violation) => violation.source)).size;
              setStatus({ state: "repairing", round: data.round, count });
            } else if (event === "done" && data.deckId)
              void open(data.deckId, data.violations ?? [], usageRef.current);
            else if (event === "failed") {
              const runId = data.error.details?.runId;
              setStatus(
                data.error.code === "DECK_EXISTS" && typeof runId === "string"
                  ? { state: "taken", runId, error: data.error }
                  : { state: "failed", error: data.error },
              );
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return onFinished();
        setStatus({
          state: "failed",
          error:
            error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) },
        });
      }
    })();
    // The run starts once; the parent remounts this component for a new run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAs = async () => {
    if (status.state !== "taken") return;
    setSaveAsError(null);
    try {
      const { deckId } = await saveGeneratedDeck(status.runId, saveAsName);
      await open(deckId, [], usageRef.current);
    } catch (error) {
      setSaveAsError(
        error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: String(error) },
      );
    }
  };

  // US-19: generating (also from a file) runs on the "generate" task's model.
  const model = useLlmStatus().modelFor("generate");
  return (
    <section className="generate-progress" aria-label="Generation" data-testid="generate-progress">
      <p className="status" role="status">
        {status.state === "running"
          ? `Writing slides${model ? ` with ${model}` : ""}… ${slides.length}`
          : status.state === "repairing"
            ? `Repairing ${status.count} slide${status.count === 1 ? "" : "s"} (round ${status.round})…`
            : status.state === "taken"
              ? "The deck is ready, but its name was taken meanwhile."
              : "Generation stopped. Nothing was saved."}
      </p>
      {status.state === "running" || status.state === "repairing" ? (
        <SendsTo provider={sendsTo} />
      ) : (
        <UsageNote run={usage} />
      )}
      <ol className="generated-slides">
        {slides.map((draft, index) => (
          <li key={index} className="generated-slide" data-testid="generated-slide">
            <span className="badge">{draft.type ?? "slide"}</span>
            <strong>{heading(draft)}</strong>
          </li>
        ))}
      </ol>
      {status.state === "failed" ? (
        <>
          <ErrorNotice error={status.error} />
          <button type="button" onClick={onFinished}>
            Back to the form
          </button>
        </>
      ) : null}
      {status.state === "taken" ? (
        <form
          className="ai-row"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAs();
          }}
        >
          <input
            aria-label="Save as"
            value={saveAsName}
            onChange={(event) => setSaveAsName(event.target.value)}
          />
          <button type="submit" className="primary">
            Save as
          </button>
        </form>
      ) : null}
      {saveAsError ? <ErrorNotice error={saveAsError} /> : null}
    </section>
  );
}
