// US-21 (D40): which listed models can chat. Shared, so Settings can say why a saved model is missing.

/** Words in a model ID that mean it can't chat (embeddings, audio, images, moderation, completions). */
export const NON_CHAT_WORDS = [
  "embed",
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "whisper",
  "image",
  "dall-e",
  "moderation",
  "instruct",
] as const;

/** True when the ID names a model that can't chat (the name rule, used when no capability fields are sent). */
export function hasNonChatName(id: string): boolean {
  const lower = id.toLowerCase();
  return NON_CHAT_WORDS.some((word) => lower.includes(word));
}

/** OpenAI's chat families: `gpt-…`, `chatgpt-…`, and `o` followed by a digit (`o3`, `o4-mini`). */
export function isOpenAiChatName(id: string): boolean {
  return /^(gpt-|chatgpt-|o\d)/i.test(id) && !hasNonChatName(id);
}
