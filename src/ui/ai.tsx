import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { LOCAL_AI_PROVIDER, type AiProvider, type AiTask, type SettingsView } from "../shared/api";
import { modelId, paidModel } from "../shared/taskModels";
import { getSettings } from "./api";

/**
 * Where an AI task runs, from settings (US-19, US-24): its own model, else the local default.
 * `provider` is the paid provider it sends content to, or Local; for a provider that is gone it is
 * null and `removed` names it (the run will fail with LLM_PROVIDER_MISSING). null when the task
 * can't run: a local task without a local model.
 */
export function taskTarget(
  settings: SettingsView | undefined,
  task: AiTask,
): { model: string; provider: AiProvider | null; removed: string | null } | null {
  const llm = settings?.llm ?? null;
  const chosen = llm ? llm.taskModels?.[task] : settings?.paidTaskModels?.[task];
  const paid = paidModel(chosen);
  if (paid) {
    const provider = settings?.providers?.find((item) => item.id === paid.provider);
    return provider
      ? {
          model: paid.model,
          provider: { id: provider.id, label: provider.label, kind: provider.kind },
          removed: null,
        }
      : { model: paid.model, provider: null, removed: paid.provider };
  }
  if (!llm?.baseUrl || !llm.model) return null;
  return { model: chosen ? modelId(chosen) : llm.model, provider: { ...LOCAL_AI_PROVIDER }, removed: null };
}

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
    /** The model an AI task runs on: its own (US-19), else the default; null when it can't run. */
    modelFor: (task: AiTask) => taskTarget(settings.data, task)?.model ?? null,
    /** US-24: the model and provider an AI task runs on, or null. */
    targetFor: (task: AiTask) => taskTarget(settings.data, task),
  };
}

/**
 * US-24 (security § Data protection): says where a run sends deck content, before and while it
 * runs. Nothing for local runs: their content stays on this machine.
 */
export function SendsTo({ provider }: { provider: AiProvider | null | undefined }) {
  if (!provider || provider.kind === "local") return null;
  return (
    <small className="sends-to" data-testid="sends-to" role="note">
      Sends to {provider.label}
    </small>
  );
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
  const status = useLlmStatus();
  const { loading } = status;
  const target = task ? status.targetFor(task) : null;
  const model = target?.model ?? null;
  // A task on a paid model can run without a local model; a removed provider still runs, so the
  // panel can say what's wrong (LLM_PROVIDER_MISSING).
  const configured = task ? Boolean(target) : status.configured;
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
      {configured ? <SendsTo provider={target?.provider} /> : null}
      {!loading && !configured ? (
        <Link to="/settings" className="ai-setup">
          Set up a local model
        </Link>
      ) : null}
    </span>
  );
}
