import type { ProviderKind } from "../../shared/api.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider, type LlmConfig, type LlmProvider } from "./provider.js";

/** Where a request goes: the local server, or a paid provider with its own key (US-21). */
export type LlmTarget =
  | { kind: "local"; baseUrl: string; apiKey: string | null }
  | { kind: ProviderKind; baseUrl: string; apiKey: string };

/**
 * The adapter for a target (api-contracts § Internal interfaces): Anthropic gets its own (D33);
 * OpenAI, other hosted services and the local server share the OpenAI-compatible one. Each key is
 * only ever sent to its own target's base URL.
 */
export function providerFor(target: LlmTarget | LlmConfig, timeoutMs?: number): LlmProvider {
  const config: LlmConfig = { ...target, timeoutMs: timeoutMs ?? (target as LlmConfig).timeoutMs };
  return target.kind === "anthropic" ? new AnthropicProvider(config) : new OpenAiCompatibleProvider(config);
}

/** Fixed base URLs of the providers that have one (data-model § Provider). */
export const PROVIDER_BASE_URLS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
} as const;

/** Test seams: point a fixed-URL kind at a fake server (`FLIPBOOK_STUDIO_ANTHROPIC_URL`, `…_OPENAI_URL`). */
const URL_OVERRIDES = {
  anthropic: "FLIPBOOK_STUDIO_ANTHROPIC_URL",
  openai: "FLIPBOOK_STUDIO_OPENAI_URL",
} as const;

/** The base URL of a fixed-URL provider kind. */
export function fixedBaseUrl(kind: "anthropic" | "openai", env: NodeJS.ProcessEnv = process.env): string {
  return env[URL_OVERRIDES[kind]]?.trim() || PROVIDER_BASE_URLS[kind];
}
