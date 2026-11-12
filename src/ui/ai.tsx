import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const { configured, loading } = useLlmStatus();
  return (
    <span className="ai-action" data-testid="ai-action">
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled || loading || !configured}
        title={configured ? title : "Set up a local model in Settings first."}
      >
        <span aria-hidden="true">✦ </span>
        {children}
      </button>
      {!loading && !configured ? (
        <Link to="/settings" className="ai-setup">
          Set up a local model
        </Link>
      ) : null}
    </span>
  );
}
