import { API_KEY_MASK } from "../../shared/api.js";

/** Keys shorter than this are only ever shown as the mask, and too short to scrub reliably. */
const MIN_HINT_LENGTH = 12;
const MIN_SCRUB_LENGTH = 8;

/**
 * How a stored key is shown (D34): its first 3 and last 4 characters, such as `sk-…a1b2`.
 * A key too short for that to hide most of it is shown as the plain mask.
 */
export function apiKeyHint(key: string): string {
  return key.length >= MIN_HINT_LENGTH ? `${key.slice(0, 3)}…${key.slice(-4)}` : API_KEY_MASK;
}

/**
 * Replaces every key in `text` with its hint (security § Data protection). Each key is also
 * matched in its JSON-escaped form, so a key inside a serialized error is caught too.
 */
export function scrubKeys(text: string, keys: Iterable<string | null | undefined>): string {
  const unique = [...new Set([...keys].filter((key): key is string => Boolean(key)))]
    .filter((key) => key.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of unique) {
    const hint = apiKeyHint(key);
    for (const form of new Set([key, JSON.stringify(key).slice(1, -1)]))
      if (out.includes(form)) out = out.split(form).join(hint);
  }
  return out;
}
