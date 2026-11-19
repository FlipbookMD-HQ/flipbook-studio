import {
  AI_TASK_LABELS,
  LOCAL_AI_PROVIDER,
  type AiProvider,
  type AiTask,
  type LlmSettings,
  type Settings,
} from "../../shared/api.js";
import { paidModel } from "../../shared/taskModels.js";
import { StudioError } from "../errors.js";
import { ANTHROPIC_CONTEXT_LENGTH, MAX_OUTPUT_TOKENS } from "../llm/anthropic.js";
import type { LlmProvider, ModelInfo } from "../llm/provider.js";
import type { FailureContext, ProviderFactory } from "../llm/routes.js";
import { LLM_DEFAULTS } from "../settings.js";

/** D35: the context length of a hosted model whose list doesn't report one (OpenAI and the rest). */
export const HOSTED_CONTEXT_LENGTH = 128_000;

/** Where an AI task runs (US-19, US-24): resolved per request, before streaming (D30). */
export interface TaskLlm {
  /** The LLM settings with `model` (and, for a paid provider, `baseUrl`) set to what the task runs on. */
  llm: LlmSettings & { model: string };
  /** The adapter, bound to the task: its chat requests carry the task (`max_tokens`, D35). */
  provider: LlmProvider;
  /** The task's label, for messages. */
  task: string;
  /** Who gets the content: `{ id: "local", … }` or the paid provider. */
  providerInfo: AiProvider;
  /** Set for a paid provider: names it in errors and shows its key only as the hint. */
  failure?: FailureContext;
  /** D35: the context length used when the model list doesn't report one. */
  contextLength: number | null;
  /** D35: the output limit the adapter sends where the provider needs one. */
  maxTokens: number;
}

/**
 * The model and provider for an AI task, with no fallback (D30, D41): a task on a paid model goes
 * only to that provider; a removed provider is 409 LLM_PROVIDER_MISSING; a local task without a
 * local LLM is 409 LLM_NOT_CONFIGURED. Both are thrown before any stream opens.
 */
export function resolveTaskLlm(settings: Settings, task: AiTask, factory: ProviderFactory): TaskLlm {
  const llm = settings.llm;
  const label = AI_TASK_LABELS[task];
  const maxTokens = MAX_OUTPUT_TOKENS[task];
  const chosen = llm ? llm.taskModels?.[task] : settings.paidTaskModels?.[task];
  const paid = paidModel(chosen);
  if (paid) {
    const provider = settings.providers?.find((item) => item.id === paid.provider);
    if (!provider)
      throw new StudioError(
        409,
        "LLM_PROVIDER_MISSING",
        `${label} uses ${paid.provider}, which was removed. Choose a model in Settings.`,
        { details: { task, provider: paid.provider } },
      );
    const base = llm ?? { baseUrl: provider.baseUrl, ...LLM_DEFAULTS };
    const timeoutMs = base.timeoutMs;
    const contextLength = provider.kind === "anthropic" ? ANTHROPIC_CONTEXT_LENGTH : HOSTED_CONTEXT_LENGTH;
    const adapter = factory({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      timeoutMs,
    });
    return {
      // The local key never travels with a paid task; the provider's own key is in the adapter.
      llm: { ...base, baseUrl: provider.baseUrl, apiKey: null, model: paid.model },
      provider: bindTask(adapter, task, { model: paid.model, contextLength }),
      task: label,
      providerInfo: { id: provider.id, label: provider.label, kind: provider.kind },
      failure: { label: provider.label, apiKey: provider.apiKey },
      contextLength,
      maxTokens,
    };
  }
  if (!llm?.baseUrl || !llm.model)
    throw new StudioError(409, "LLM_NOT_CONFIGURED", "Set up a local model in Settings first.");
  const adapter = factory({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, timeoutMs: llm.timeoutMs });
  return {
    llm: { ...llm, model: typeof chosen === "string" ? chosen : llm.model },
    provider: bindTask(adapter, task, null),
    task: label,
    providerInfo: { ...LOCAL_AI_PROVIDER },
    contextLength: null,
    maxTokens,
  };
}

/**
 * The adapter as one task sees it: every chat names the task (so `max_tokens` follows D35). For a
 * paid provider, the task's model gets the kind's default context length (D35) when the list
 * doesn't report one, doesn't list it, or can't be read. Local models keep the budget's default.
 */
function bindTask(
  inner: LlmProvider,
  task: AiTask,
  paid: { model: string; contextLength: number } | null,
): LlmProvider {
  return {
    async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
      if (!paid) return inner.listModels(signal);
      const models = await inner.listModels(signal).catch((): ModelInfo[] => []);
      const listed = models.map((model) => ({
        ...model,
        contextLength: model.contextLength ?? paid.contextLength,
      }));
      return listed.some((model) => model.id === paid.model)
        ? listed
        : [...listed, { id: paid.model, contextLength: paid.contextLength }];
    },
    chat: (request) => inner.chat({ ...request, task }),
  };
}
