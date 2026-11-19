import { useEffect, useState } from "react";
import {
  PROVIDER_KINDS,
  PROVIDER_KIND_LABELS,
  type ApiError,
  type LlmTestResponse,
  type ProviderKind,
  type ProviderView,
} from "../../shared/api";
import {
  ApiRequestError,
  createProvider,
  deleteProvider,
  listLlmModels,
  testLlm,
  updateProvider,
} from "../api";
import { ErrorNotice } from "./Shell";

// US-21: Settings → Providers. Paid providers sit beside the local model; adding one changes no
// AI task (tasks choose a provider in US-24). Keys are typed, never shown again: only the hint.

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

/** What to do next, for the errors a provider gives. */
export const PROVIDER_HINTS: Partial<Record<ApiError["code"], string>> = {
  LLM_UNAUTHORIZED: "Check the key in your provider account, then use Replace key.",
  LLM_NO_CREDIT: "Add credit or a payment method in your provider account.",
  LLM_RATE_LIMITED: "Wait a moment, then try again.",
  LLM_UNREACHABLE: "Check your network connection and the base URL.",
  LLM_MODEL_NOT_FOUND: "Pick a model from the list.",
  LLM_TIMEOUT: "Try again; the service may be busy.",
};

function Failure({ error, testId }: { error: ApiError; testId: string }) {
  return (
    <div data-testid={testId}>
      <ErrorNotice error={error} />
      {PROVIDER_HINTS[error.code] ? <p className="muted">{PROVIDER_HINTS[error.code]}</p> : null}
    </div>
  );
}

/** One line for a test result: the reply, its latency and, when reported, its tokens. */
export function testSummary(result: LlmTestResponse): string {
  const tokens = result.usage ? ` · ${result.usage.input} in / ${result.usage.output} out tokens` : "";
  return `“${result.reply}” in ${result.latencyMs} ms${tokens}`;
}

/** The kinds still available to add: one anthropic, one openai, any number of others. */
export function addableKinds(providers: ProviderView[]): ProviderKind[] {
  return PROVIDER_KINDS.filter(
    (kind) => kind === "openai-compatible" || !providers.some((provider) => provider.kind === kind),
  );
}

/** A saved provider: its models, a test, Replace key and Remove. */
export function ProviderCard({
  provider,
  listOnMount = false,
  onChanged,
  onRemoved,
}: {
  provider: ProviderView;
  /** List the models at once (right after the provider was added). */
  listOnMount?: boolean;
  onChanged: (provider: ProviderView) => void;
  onRemoved: (id: string) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState("");
  const [modelsError, setModelsError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [test, setTest] = useState<{ result?: LlmTestResponse; error?: ApiError; running?: boolean }>({});
  const [replacing, setReplacing] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<ApiError | null>(null);

  const refresh = async () => {
    setLoading(true);
    setModelsError(null);
    try {
      const ids = (await listLlmModels({ providerId: provider.id })).models.map((item) => item.id);
      setModels(ids);
      setModel((current) => (ids.includes(current) ? current : (ids[0] ?? "")));
    } catch (error) {
      setModels(null);
      setModelsError(asApiError(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (listOnMount) void refresh();
    // Only when the card first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTest = async () => {
    setTest({ running: true });
    try {
      setTest({ result: await testLlm({ providerId: provider.id, model }) });
    } catch (error) {
      setTest({ error: asApiError(error) });
    }
  };

  const saveKey = async () => {
    setKeyError(null);
    try {
      onChanged(await updateProvider(provider.id, { apiKey: newKey }));
      setNewKey("");
      setReplacing(false);
      setTest({});
      void refresh();
    } catch (error) {
      setKeyError(asApiError(error));
    }
  };

  const remove = async () => {
    setRemoveError(null);
    try {
      await deleteProvider(provider.id);
      onRemoved(provider.id);
    } catch (error) {
      setRemoveError(asApiError(error));
    }
  };

  return (
    <article className="provider-card" aria-label={provider.label} data-testid={`provider-${provider.id}`}>
      <header className="provider-head">
        <strong>{provider.label}</strong>
        <span className="tag">{PROVIDER_KIND_LABELS[provider.kind]}</span>
        <code className="muted small">{provider.baseUrl}</code>
        <span className="mono small" data-testid="key-hint">
          Key {provider.apiKeyHint}
        </span>
      </header>
      <div className="kit-row">
        <label className="field compact">
          <span>Model</span>
          <select
            aria-label={`Model of ${provider.label}`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={!models?.length}
          >
            {models?.length ? null : (
              <option value="">{models ? "No chat models" : "List models first"}</option>
            )}
            {(models ?? []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : models ? "Refresh models" : "List models"}
        </button>
        <button type="button" onClick={() => void runTest()} disabled={!model || test.running}>
          {test.running ? "Testing…" : "Test"}
        </button>
      </div>
      {models ? (
        <p className="muted small" data-testid="model-count">
          {models.length} chat {models.length === 1 ? "model" : "models"}
        </p>
      ) : null}
      {modelsError ? <Failure error={modelsError} testId="provider-models-error" /> : null}
      <div data-testid="provider-test-result" aria-live="polite">
        {test.result ? <p className="ok">{testSummary(test.result)}</p> : null}
        {test.error ? <Failure error={test.error} testId="provider-test-error" /> : null}
      </div>
      {replacing ? (
        <div className="kit-row">
          <label className="field narrow">
            <span>New API key</span>
            <input
              type="password"
              autoComplete="off"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
            />
          </label>
          <button type="button" className="primary" disabled={!newKey.trim()} onClick={() => void saveKey()}>
            Save key
          </button>
          <button
            type="button"
            onClick={() => {
              setReplacing(false);
              setNewKey("");
              setKeyError(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {keyError ? <ErrorNotice error={keyError} /> : null}
      {confirming ? (
        <div className="warning" role="group" aria-label={`Remove ${provider.label}`}>
          <p>Remove {provider.label}? Its key is deleted from this machine.</p>
          <div className="kit-row">
            <button type="button" className="danger" onClick={() => void remove()}>
              Remove provider
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="kit-row">
          {replacing ? null : (
            <button type="button" onClick={() => setReplacing(true)}>
              Replace key
            </button>
          )}
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            Remove
          </button>
        </div>
      )}
      {removeError ? <ErrorNotice error={removeError} /> : null}
    </article>
  );
}

/** Add a provider: a kind, a base URL (Other only), an optional name and the key. */
export function AddProviderForm({
  providers,
  onAdded,
  onCancel,
}: {
  providers: ProviderView[];
  onAdded: (provider: ProviderView) => void;
  onCancel: () => void;
}) {
  const kinds = addableKinds(providers);
  const [kind, setKind] = useState<ProviderKind>(kinds[0] ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState(false);
  const other = kind === "openai-compatible";
  const reason = !apiKey.trim()
    ? "Enter the API key."
    : other && !baseUrl.trim()
      ? "Enter the base URL."
      : null;

  const add = async () => {
    setError(null);
    setAdding(true);
    try {
      const provider = await createProvider({
        kind,
        apiKey,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(other ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey("");
      onAdded(provider);
    } catch (failure) {
      setError(asApiError(failure));
    } finally {
      setAdding(false);
    }
  };

  return (
    <form
      className="provider-card"
      aria-label="Add a provider"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason) void add();
      }}
    >
      <fieldset className="choices segmented-radios">
        <legend>Provider</legend>
        {PROVIDER_KINDS.map((item) => (
          <label key={item} className="choice">
            <input
              type="radio"
              name="provider-kind"
              checked={kind === item}
              disabled={!kinds.includes(item)}
              onChange={() => setKind(item)}
            />
            {PROVIDER_KIND_LABELS[item]}
          </label>
        ))}
      </fieldset>
      {other ? (
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://openrouter.ai/api/v1"
          />
        </label>
      ) : null}
      <label className="field narrow">
        <span>Name (optional)</span>
        <input value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label className="field narrow">
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <p className="muted small">
        The key is stored only in Studio&apos;s settings file on this machine, never in a deck, and is shown
        again only as a hint.
      </p>
      {error ? <Failure error={error} testId="add-provider-error" /> : null}
      <div className="kit-row">
        {reason ? <span className="muted">{reason}</span> : null}
        <button type="submit" className="primary" disabled={Boolean(reason) || adding}>
          {adding ? "Adding…" : "Add"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Settings → Providers: the saved providers and a form to add one. */
export function ProvidersSection({
  providers,
  onChange,
}: {
  providers: ProviderView[];
  /** The new list, after an add, a change or a removal. */
  onChange: (providers: ProviderView[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  return (
    <div className="settings-card" id="providers" data-testid="providers">
      <h2 className="card-title">Providers</h2>
      <p className="muted">
        Connect Claude, OpenAI or another hosted OpenAI-compatible service with your API key. Adding a
        provider changes no AI task: every task keeps its local model until you choose otherwise.
      </p>
      {providers.length ? null : (
        <p className="muted" data-testid="no-providers">
          No paid providers.
        </p>
      )}
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          listOnMount={provider.id === justAdded}
          onChanged={(next) => onChange(providers.map((item) => (item.id === next.id ? next : item)))}
          onRemoved={(id) => onChange(providers.filter((item) => item.id !== id))}
        />
      ))}
      {adding ? (
        <AddProviderForm
          providers={providers}
          onAdded={(provider) => {
            setJustAdded(provider.id);
            setAdding(false);
            onChange([...providers, provider]);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="kit-row">
          <button type="button" onClick={() => setAdding(true)}>
            Add a provider
          </button>
        </div>
      )}
    </div>
  );
}
