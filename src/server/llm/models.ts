import type { ProviderKind } from "../../shared/api.js";
import { hasNonChatName, isOpenAiChatName } from "../../shared/chatModels.js";
import type { ModelInfo } from "./provider.js";

/** What a model list belongs to: the local server or a paid provider's kind. */
export type TargetKind = "local" | ProviderKind;

const CHAT_CAPABILITIES = new Set(["chat", "completion", "completion_chat"]);

/**
 * D40: can this listed model chat? Capability fields win where the server sends them, name rules
 * apply where it doesn't:
 * - anthropic: every model.
 * - openai: `gpt-`, `chatgpt-` or `o<digit>`, minus the non-chat words.
 * - openai-compatible and local: OpenRouter's modalities must both include "text"; a `capabilities`
 *   list must include "chat" or "completion"; otherwise no non-chat word in the ID.
 */
export function isChatModel(kind: TargetKind, model: ModelInfo): boolean {
  switch (kind) {
    case "anthropic":
      return true;
    case "openai":
      return isOpenAiChatName(model.id);
    default:
      if (model.modalities)
        return model.modalities.input.includes("text") && model.modalities.output.includes("text");
      if (model.capabilities)
        return model.capabilities.some((capability) => CHAT_CAPABILITIES.has(capability.toLowerCase()));
      return !hasNonChatName(model.id);
  }
}

/** The models that can chat, as the API returns them (`id` and `contextLength` only). */
export function chatModels(kind: TargetKind, models: ModelInfo[]): { id: string; contextLength?: number }[] {
  return models
    .filter((model) => isChatModel(kind, model))
    .map(({ id, contextLength }) => ({ id, ...(contextLength != null ? { contextLength } : {}) }));
}
