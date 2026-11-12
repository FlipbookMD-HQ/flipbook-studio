import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_KEY_MASK, type ApiError, type LlmTestResponse } from "../../shared/api";
import { ApiRequestError, getSettings, listLlmModels, putSettings, testLlm } from "../api";
import { ErrorNotice, Shell } from "./Shell";

const PRESETS = [
  { id: "ollama", label: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { id: "custom", label: "Custom", url: "" },
] as const;
type PresetId = (typeof PRESETS)[number]["id"];

const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

const HINTS: Partial<Record<ApiError["code"], string>> = {
  LLM_UNREACHABLE: "Check that the server is running and the URL and port are right.",
  LLM_UNAUTHORIZED: "Check the API key. Local servers usually need none.",
  LLM_MODEL_NOT_FOUND: "Pick a model from the list, or install it first.",
  LLM_TIMEOUT: "The model may still be loading. Try again, or raise the timeout.",
};

/** The host a URL sends deck content to, when it isn't this machine. */
function remoteHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host) ? null : host;
  } catch {
    return null;
  }
}

function presetFor(url: string): PresetId {
  const normalized = url.trim().replace(/\/+$/, "");
  return PRESETS.find((preset) => preset.url && preset.url === normalized)?.id ?? "custom";
}

/** Settings → Local model: where the LLM is, which model, and a connection test. */
export function SettingsScreen() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const [baseUrl, setBaseUrl] = useState("");
  const [preset, setPreset] = useState<PresetId>("ollama");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [temperature, setTemperature] = useState(0.2);
  const [timeoutS, setTimeoutS] = useState(60);
  const [repairRounds, setRepairRounds] = useState(1);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<ApiError | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [test, setTest] = useState<{ result?: LlmTestResponse; error?: ApiError; running?: boolean }>({});
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    const llm = settings.data.llm;
    const url = llm?.baseUrl ?? PRESETS[0].url;
    setBaseUrl(url);
    setPreset(presetFor(url));
    setModel(llm?.model ?? "");
    setApiKey(llm?.apiKey ? API_KEY_MASK : "");
    setKeyTouched(false);
    if (llm) {
      setTemperature(llm.temperature);
      setTimeoutS(Math.round(llm.timeoutMs / 1000));
      setRepairRounds(llm.maxRepairRounds);
    }
  }, [settings.data]);

  // The key to send for an unsaved connection: left out keeps the saved one.
  const keyForRequest = () => (keyTouched ? apiKey || null : undefined);

  const refreshModels = async (url = baseUrl) => {
    if (!url) return;
    setLoadingModels(true);
    setModelsError(null);
    try {
      const response = await listLlmModels({ baseUrl: url, apiKey: keyForRequest() });
      setModels(response.models.map((item) => item.id));
      if (response.models.length && !response.models.some((item) => item.id === model))
        setModel(response.models[0]!.id);
    } catch (error) {
      setModels(null);
      setModelsError(asApiError(error));
    } finally {
      setLoadingModels(false);
    }
  };

  const pickPreset = (id: PresetId) => {
    setPreset(id);
    const url = PRESETS.find((item) => item.id === id)!.url;
    if (url) {
      setBaseUrl(url);
      void refreshModels(url);
    }
  };

  const runTest = async () => {
    setTest({ running: true });
    try {
      setTest({
        result: await testLlm({ baseUrl, model, apiKey: keyForRequest(), timeoutMs: timeoutS * 1000 }),
      });
    } catch (error) {
      setTest({ error: asApiError(error) });
    }
  };

  const save = async () => {
    setSaveError(null);
    setSaved(false);
    try {
      const next = await putSettings({
        llm: {
          baseUrl,
          model: model || null,
          ...(keyTouched ? { apiKey: apiKey || null } : {}),
          temperature,
          timeoutMs: timeoutS * 1000,
          maxRepairRounds: repairRounds,
        },
      });
      queryClient.setQueryData(["settings"], next);
      setSaved(true);
    } catch (error) {
      setSaveError(asApiError(error));
    }
  };

  const disconnect = async () => {
    try {
      queryClient.setQueryData(["settings"], await putSettings({ llm: null }));
      setModels(null);
      setTest({});
    } catch (error) {
      setSaveError(asApiError(error));
    }
  };

  if (settings.isPending) return <Shell crumb="Settings">Loading settings…</Shell>;
  if (settings.isError)
    return (
      <Shell crumb="Settings">
        <ErrorNotice error={asApiError(settings.error)} />
      </Shell>
    );

  const host = remoteHost(baseUrl);
  const reason = !/^https?:\/\/\S+$/i.test(baseUrl.trim())
    ? "Enter an http:// or https:// base URL."
    : !model
      ? "Pick a model."
      : null;
  const offered =
    models && model && !models.includes(model) ? [model, ...models] : (models ?? (model ? [model] : []));

  return (
    <Shell
      crumb="Settings"
      actions={
        <>
          {reason ? (
            <span className="muted" data-testid="save-reason">
              {reason}
            </span>
          ) : null}
          <button type="button" className="primary" disabled={Boolean(reason)} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <h1>Settings</h1>
      <section className="settings" aria-labelledby="llm-title">
        <h2 id="llm-title">Local model</h2>
        <p className="muted">
          AI features use an OpenAI-compatible server on your machine, such as Ollama or LM Studio. Settings
          are stored outside your decks.
        </p>
        {saveError ? <ErrorNotice error={saveError} /> : null}
        {saved ? (
          <p className="ok" role="status">
            Saved. AI features use {model}.
          </p>
        ) : null}
        <fieldset className="choices">
          <legend>Server</legend>
          {PRESETS.map((item) => (
            <label key={item.id} className="choice">
              <input
                type="radio"
                name="preset"
                checked={preset === item.id}
                onChange={() => pickPreset(item.id)}
              />
              {item.label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setPreset(presetFor(event.target.value));
            }}
            onBlur={() => void refreshModels()}
            placeholder="http://127.0.0.1:11434/v1"
          />
        </label>
        {host ? (
          <p className="warning" data-testid="remote-notice">
            Deck content will be sent to {host}.
          </p>
        ) : null}
        <div className="kit-row">
          <label className="field compact">
            <span>Model</span>
            <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
              {offered.length ? null : <option value="">No model</option>}
              {offered.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void refreshModels()} disabled={loadingModels || !baseUrl}>
            {loadingModels ? "Loading…" : "Refresh models"}
          </button>
        </div>
        {models && models.length === 0 ? (
          <p className="warning" data-testid="no-models">
            No models — <code>ollama pull &lt;model&gt;</code>
          </p>
        ) : null}
        {modelsError ? (
          <div data-testid="models-error">
            <ErrorNotice error={modelsError} />
            {HINTS[modelsError.code] ? <p className="muted">{HINTS[modelsError.code]}</p> : null}
          </div>
        ) : null}
        <label className="field narrow">
          <span>API key (optional)</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setKeyTouched(true);
            }}
            onFocus={() => {
              if (apiKey === API_KEY_MASK) {
                setApiKey("");
                setKeyTouched(true);
              }
            }}
          />
        </label>
        <details>
          <summary>Advanced</summary>
          <div className="kit-row">
            <label className="field compact">
              <span>Temperature</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
              />
            </label>
            <label className="field compact">
              <span>Timeout (seconds)</span>
              <input
                type="number"
                min={5}
                max={600}
                value={timeoutS}
                onChange={(event) => setTimeoutS(Number(event.target.value))}
              />
            </label>
            <label className="field compact">
              <span>Repair rounds</span>
              <input
                type="number"
                min={0}
                max={3}
                value={repairRounds}
                onChange={(event) => setRepairRounds(Number(event.target.value))}
              />
            </label>
          </div>
        </details>
        <div className="kit-row">
          <button type="button" onClick={() => void runTest()} disabled={Boolean(reason) || test.running}>
            {test.running ? "Testing…" : "Test"}
          </button>
          {settings.data.llm ? (
            <button type="button" className="danger" onClick={() => void disconnect()}>
              Disconnect
            </button>
          ) : null}
        </div>
        <div data-testid="test-result" aria-live="polite">
          {test.result ? (
            <p className="ok">
              “{test.result.reply}” in {test.result.latencyMs} ms
            </p>
          ) : null}
          {test.error ? (
            <>
              <ErrorNotice error={test.error} />
              {HINTS[test.error.code] ? <p className="muted">{HINTS[test.error.code]}</p> : null}
            </>
          ) : null}
        </div>
      </section>
    </Shell>
  );
}
