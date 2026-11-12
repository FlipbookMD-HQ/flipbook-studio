import type { LlmProvider } from "../llm/provider.js";

export const DEFAULT_CONTEXT_TOKENS = 8192;
const CHARS_PER_TOKEN = 4;

export interface ContextPart {
  name: string;
  text: string;
  /** 0 is required and never dropped; higher numbers are dropped first. */
  priority: number;
}

/**
 * Fits prompt parts into 80% of the model's context (about 4 characters per token), dropping the
 * least important parts first. Required parts (priority 0) are always kept.
 */
export function fit(
  parts: ContextPart[],
  contextTokens = DEFAULT_CONTEXT_TOKENS,
): { parts: ContextPart[]; trimmed: boolean } {
  const budget = Math.floor(contextTokens * 0.8 * CHARS_PER_TOKEN);
  let used = parts.reduce((sum, part) => sum + part.text.length, 0);
  const dropped = new Set<ContextPart>();
  const candidates = parts
    .filter((part) => part.priority > 0)
    .sort((a, b) => b.priority - a.priority || parts.indexOf(b) - parts.indexOf(a));
  for (const part of candidates) {
    if (used <= budget) break;
    dropped.add(part);
    used -= part.text.length;
  }
  return { parts: parts.filter((part) => !dropped.has(part)), trimmed: dropped.size > 0 };
}

const contextCache = new Map<string, number>();

/** The model's context length from /v1/models metadata, or 8k. Cached per base URL and model. */
export async function contextTokens(
  provider: LlmProvider,
  baseUrl: string,
  model: string,
  signal: AbortSignal,
): Promise<number> {
  const key = `${baseUrl}|${model}`;
  const cached = contextCache.get(key);
  if (cached) return cached;
  let tokens = DEFAULT_CONTEXT_TOKENS;
  try {
    const found = (await provider.listModels(signal)).find((item) => item.id === model);
    if (found?.contextLength && found.contextLength > 0) tokens = found.contextLength;
  } catch {
    // Metadata is optional: the default stands.
  }
  contextCache.set(key, tokens);
  return tokens;
}

/** For tests. */
export function resetContextCache() {
  contextCache.clear();
}
