import type { PaidTaskModel, TaskModel } from "./api.js";

// US-24 (D32): a task model is a local model ID (string) or `{ provider, model }`.

/** The paid provider a task model points to, or null for a local model. */
export function paidModel(value: TaskModel | null | undefined): PaidTaskModel | null {
  return value && typeof value === "object" ? value : null;
}

/** The model ID of a task model, local or paid. */
export function modelId(value: TaskModel): string {
  return typeof value === "string" ? value : value.model;
}

/**
 * A task model as one string, for a <select> value: a local model is its ID as is, and a paid one
 * is JSON (local model IDs never start with "{").
 */
export function encodeTaskModel(value: TaskModel | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : JSON.stringify({ provider: value.provider, model: value.model });
}

/** The reverse of encodeTaskModel; "" is "Same as default" (null). */
export function decodeTaskModel(value: string): TaskModel | null {
  if (!value) return null;
  if (!value.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(value) as { provider?: unknown; model?: unknown };
    if (typeof parsed.provider === "string" && typeof parsed.model === "string")
      return { provider: parsed.provider, model: parsed.model };
  } catch {
    // Not JSON after all: a local ID.
  }
  return value;
}
