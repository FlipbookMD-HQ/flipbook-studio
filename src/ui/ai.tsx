import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  LOCAL_AI_PROVIDER,
  type AiProvider,
  type AiTask,
  type SettingsView,
  type Usage,
} from "../shared/api";
import { modelId, paidModel } from "../shared/taskModels";
import { getSettings, type AiEvent } from "./api";

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

/** US-25: what a run used, as the AI panels track it from its events. */
export interface RunUsage {
  /** Where the run went (its `start` event); null before it starts. */
  provider: AiProvider | null;
  /** The tokens reported so far; null when none were. */
  usage: Usage | null;
  /** The run finished, failed or was cancelled: its count can be shown. */
  ended: boolean;
}
export const NO_RUN_USAGE: RunUsage = { provider: null, usage: null, ended: false };

/** The next RunUsage after one stream event (`start` begins a new run; `done`/`failed` end it). */
export function trackUsage(state: RunUsage, { event, data }: AiEvent): RunUsage {
  if (event === "start") return { provider: data.provider, usage: null, ended: false };
  if (event === "usage") return { ...state, usage: data.usage };
  if (event === "done" || event === "failed")
    return {
      provider: data.provider ?? state.provider,
      usage: data.usage !== undefined ? data.usage : state.usage,
      ended: true,
    };
  return state;
}

/** A run cancelled from the panel: it keeps the usage reported before the cancel. */
export const endUsage = (state: RunUsage): RunUsage => (state.provider ? { ...state, ended: true } : state);

const count = (value: number) => value.toLocaleString("en-US");

/** "N in · M out tokens": tokens only, never a price or an estimate (PRD non-goal). */
export const formatTokens = (usage: Usage) => `${count(usage.input)} in · ${count(usage.output)} out tokens`;

/**
 * US-25: the tokens a finished or cancelled paid run used, as its provider reported them, or
 * "usage not reported". Nothing for local runs, or while a run is still going.
 */
export function UsageNote({ run }: { run: RunUsage }) {
  if (!run.ended || !run.provider || run.provider.kind === "local") return null;
  return (
    <small className="ai-usage muted" data-testid="ai-usage" title={`Reported by ${run.provider.label}`}>
      {run.usage ? formatTokens(run.usage) : "usage not reported"}
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
