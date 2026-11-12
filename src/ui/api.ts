import {
  type CreateDeckRequest,
  DeckDetailSchema,
  ErrorEnvelopeSchema,
  TOKEN_HEADER,
  TOKEN_META,
  WorkspaceSchema,
  type ApiError,
} from "../shared/api";
import type { z } from "zod";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
  }
}

function token(): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
}

/** Every Studio API call goes through here so it carries the launch token. */
export async function apiFetch<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, token());
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(body);
    throw new ApiRequestError(
      response.status,
      envelope.success
        ? envelope.data.error
        : { code: "INTERNAL", message: `Request failed with ${response.status}.` },
    );
  }
  return schema.parse(body);
}

export const getWorkspace = () => apiFetch("/api/workspace", WorkspaceSchema);
export const getDeck = (id: string) => apiFetch(`/api/decks/${encodeURIComponent(id)}`, DeckDetailSchema);

export const createDeck = (request: CreateDeckRequest) =>
  apiFetch("/api/decks", DeckDetailSchema, { method: "POST", body: JSON.stringify(request) });
