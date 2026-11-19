import type {
  CreateProviderRequest,
  Provider,
  ProviderKind,
  ProviderView,
  UpdateProviderRequest,
} from "../shared/api.js";
import { StudioError } from "./errors.js";
import { fixedBaseUrl } from "./llm/target.js";
import { providerView, type SettingsStore } from "./settings.js";

// US-21 (D32, D34): paid providers in settings. At most one anthropic and one openai provider;
// any number of openai-compatible ones. Adding, changing or removing one never touches task models.

/** IDs a provider can't take: "local" names the local connection (US-24). */
const RESERVED_IDS = new Set(["local"]);

/** The name a provider gets when none is given: the kind, or the service's host. */
export function defaultProviderLabel(kind: ProviderKind, baseUrl: string): string {
  if (kind === "anthropic") return "Anthropic";
  if (kind === "openai") return "OpenAI";
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  // api.together.xyz → together, openrouter.ai → openrouter, localhost → localhost.
  const parts = host.replace(/^(api|www)\./, "").split(".");
  return (parts.length > 1 ? parts.slice(0, -1).join(".") : parts[0]!).slice(0, 40);
}

/** A slug of the label (/^[a-z0-9-]{1,40}$/), made unique with -2, -3… */
export function providerId(label: string, taken: Iterable<string>): string {
  const used = new Set([...taken, ...RESERVED_IDS]);
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "provider";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(id)) return id;
  }
}

const invalid = (path: string, message: string) =>
  new StudioError(422, "VALIDATION_FAILED", message, { details: { fields: [{ path, message }] } });

const providersOf = (store: SettingsStore): Provider[] => store.current().providers ?? [];

function find(store: SettingsStore, id: string): Provider {
  const provider = providersOf(store).find((item) => item.id === id);
  if (!provider) throw new StudioError(404, "PROVIDER_NOT_FOUND", `There's no provider "${id}".`);
  return provider;
}

/** POST /api/providers: adds a provider and returns it with its key hint. */
export async function addProvider(
  store: SettingsStore,
  request: CreateProviderRequest,
): Promise<ProviderView> {
  const providers = providersOf(store);
  let baseUrl: string;
  if (request.kind === "openai-compatible") {
    if (!request.baseUrl) throw invalid("baseUrl", "Enter the service's base URL.");
    baseUrl = request.baseUrl;
  } else {
    if (request.baseUrl) throw invalid("baseUrl", "This provider's URL is fixed.");
    const existing = providers.find((item) => item.kind === request.kind);
    if (existing)
      throw new StudioError(
        409,
        "PROVIDER_EXISTS",
        `${existing.label} is already connected. Replace its key instead of adding it again.`,
        { details: { providerId: existing.id } },
      );
    baseUrl = fixedBaseUrl(request.kind);
  }
  const label = request.label ?? defaultProviderLabel(request.kind, baseUrl);
  const provider: Provider = {
    id: providerId(
      label,
      providers.map((item) => item.id),
    ),
    kind: request.kind,
    label,
    baseUrl,
    apiKey: request.apiKey,
  };
  await store.setProviders([...providers, provider]);
  return providerView(provider);
}

/** PATCH /api/providers/:id: renames it, replaces its key or (openai-compatible) moves its URL. Its ID stays. */
export async function updateProvider(
  store: SettingsStore,
  id: string,
  request: UpdateProviderRequest,
): Promise<ProviderView> {
  const current = find(store, id);
  if (request.baseUrl !== undefined && current.kind !== "openai-compatible")
    throw invalid("baseUrl", "This provider's URL is fixed.");
  const next: Provider = {
    ...current,
    ...(request.label !== undefined ? { label: request.label } : {}),
    ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
    ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
  };
  await store.setProviders(providersOf(store).map((item) => (item.id === id ? next : item)));
  return providerView(next);
}

/** DELETE /api/providers/:id. Task models that point to it are kept (they fail at run time, US-24). */
export async function removeProvider(store: SettingsStore, id: string): Promise<void> {
  find(store, id);
  await store.setProviders(providersOf(store).filter((item) => item.id !== id));
}
