import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { AiTask } from "../shared/api";
import { getSettings } from "./api";

/**
 * Whether an LLM is ready: a base URL and a chosen model in settings. Every AI feature reads it
 * through this hook so they all agree.
 */
export function useLlmStatus() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, staleTime: 30_000 });
  const llm = settings.data?.llm ?? null;
  return {
    loading: settings.isPending,
    configured: Boolean(llm?.baseUrl && llm.model),
    llm,
    /** The model an AI task runs on: its own (US-19), else the default; null without an LLM. */
    modelFor: (task: AiTask) => (llm?.model ? (llm.taskModels?.[task] ?? llm.model) : null),
  };
}

/**
 * The only way to render an AI button (US-12 to US-15 use it; see CONTRIBUTING.md). While no
 * model is set up, the button stays visible but disabled, with a link to Settings.
 */
export function AiAction({
  children,
  onClick,
  disabled = false,
  title,
  className,
  task,
}: {
  children: ReactNode;
  /** The AI task this button runs (US-19): its model is named next to the button. */
  task?: AiTask;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const { configured, loading, modelFor } = useLlmStatus();
  const model = task ? modelFor(task) : null;
  return (
    <span className="ai-action" data-testid="ai-action">
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled || loading || !configured}
        title={
          configured ? [title, model].filter(Boolean).join(" · ") : "Set up a local model in Settings first."
        }
      >
        <span aria-hidden="true">✦ </span>
        {children}
      </button>
      {configured && model ? (
        <small className="ai-model muted" data-testid="ai-model">
          {model}
        </small>
      ) : null}
      {!loading && !configured ? (
        <Link to="/settings" className="ai-setup">
          Set up a local model
        </Link>
      ) : null}
    </span>
  );
}
