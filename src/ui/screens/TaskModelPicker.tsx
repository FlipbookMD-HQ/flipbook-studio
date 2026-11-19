import { AI_TASK_LABELS, type AiTask, type ProviderView } from "../../shared/api";
import { decodeTaskModel, encodeTaskModel, paidModel } from "../../shared/taskModels";
import { modelMark } from "../modelMarks";

/**
 * Why a task's saved model can't be used as is (US-19, US-24), or null: a local model the server
 * doesn't list, a provider's model it doesn't offer, a model that isn't a chat model (D40), or a
 * provider that was removed. A list that isn't known yet marks nothing.
 */
export function taskModelProblem(
  value: string,
  localModels: string[] | null,
  providers: ProviderView[],
  providerModels: Record<string, string[] | null>,
): { mark: string; message: string } | null {
  const chosen = decodeTaskModel(value);
  if (!chosen) return null;
  const paid = paidModel(chosen);
  if (!paid) {
    const mark = modelMark(chosen as string, localModels);
    if (!mark) return null;
    return {
      mark,
      message:
        mark === "not a chat model"
          ? `${chosen as string} is not a chat model. Pick another model.`
          : `${chosen as string} isn't on this server. Pick another model, or install it.`,
    };
  }
  const provider = providers.find((item) => item.id === paid.provider);
  if (!provider)
    return {
      mark: "provider removed",
      message: `${paid.model} is from ${paid.provider}, which was removed. Pick another model.`,
    };
  const mark = modelMark(paid.model, providerModels[provider.id] ?? null);
  if (!mark) return null;
  return mark === "not a chat model"
    ? { mark, message: `${paid.model} is not a chat model. Pick another model.` }
    : {
        mark: `not offered by ${provider.label}`,
        message: `${provider.label} doesn't offer ${paid.model} any more. Pick another model.`,
      };
}

/**
 * One task's model picker in Settings → Model for each task (US-19, US-24): "Same as default" (the
 * local default model) first, then the local models, then each provider's models in its own group.
 * A task on a provider's model says that its content is sent there.
 */
export function TaskModelPicker({
  task,
  value,
  defaultModel,
  localModels,
  providers,
  providerModels,
  onChange,
}: {
  task: AiTask;
  /** The encoded task model ("" = Same as default). */
  value: string;
  defaultModel: string;
  localModels: string[] | null;
  providers: ProviderView[];
  /** Each provider's chat models, by provider ID; null while unknown. */
  providerModels: Record<string, string[] | null>;
  onChange: (value: string) => void;
}) {
  const label = AI_TASK_LABELS[task];
  const chosen = decodeTaskModel(value);
  const paid = paidModel(chosen);
  const problem = taskModelProblem(value, localModels, providers, providerModels);
  const optionText = (id: string, encoded: string) =>
    encoded === value && problem ? `${id} (${problem.mark})` : id;
  const local = [...new Set([...(chosen && !paid ? [chosen as string] : []), ...(localModels ?? [])])];
  const sendsTo = paid ? providers.find((item) => item.id === paid.provider) : undefined;
  return (
    <label className="field compact">
      <span>{label}</span>
      <select
        aria-label={`Model for ${label}`}
        value={value}
        aria-invalid={problem ? "true" : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Same as default{defaultModel ? ` (${defaultModel})` : ""}</option>
        <optgroup label="Local">
          {local.map((id) => (
            <option key={id} value={id}>
              {optionText(id, id)}
            </option>
          ))}
        </optgroup>
        {providers.map((provider) => {
          const models = providerModels[provider.id] ?? [];
          const ids = [...new Set([...(paid?.provider === provider.id ? [paid.model] : []), ...models])];
          return (
            <optgroup key={provider.id} label={provider.label}>
              {ids.map((id) => {
                const encoded = encodeTaskModel({ provider: provider.id, model: id });
                return (
                  <option key={id} value={encoded}>
                    {optionText(id, encoded)}
                  </option>
                );
              })}
            </optgroup>
          );
        })}
        {paid && !sendsTo ? (
          <optgroup label={`${paid.provider} (removed)`}>
            <option value={value}>{optionText(paid.model, value)}</option>
          </optgroup>
        ) : null}
      </select>
      {problem ? (
        <small className="field-error" data-testid={`task-model-missing-${task}`}>
          {problem.message}
        </small>
      ) : null}
      {sendsTo ? (
        <small className="sends-to" data-testid={`task-sends-${task}`}>
          Sends this task&apos;s content to {sendsTo.label}.
        </small>
      ) : null}
    </label>
  );
}
