import {
  type CreateDeckRequest,
  DeckDetailSchema,
  AddSlideResponseSchema,
  ExportJobSchema,
  ExportsInfoSchema,
  JobEventSchema,
  PresentResponseSchema,
  type ExportRequest,
  type JobEvent,
  PreviewResponseSchema,
  StructureResponseSchema,
  SaveSlideResponseSchema,
  type SlideDraft,
  ErrorEnvelopeSchema,
  TOKEN_HEADER,
  TOKEN_META,
  WorkspaceSchema,
  type ApiError,
} from "../shared/api";
import { z } from "zod";

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

export const previewSlide = (
  deckId: string,
  slideId: string,
  draft: SlideDraft | null,
  signal?: AbortSignal,
) =>
  apiFetch(`/api/decks/${encodeURIComponent(deckId)}/preview`, PreviewResponseSchema, {
    method: "POST",
    body: JSON.stringify({ slideId, draft }),
    signal,
  });

export const saveSlide = (deckId: string, slideId: string, baseHash: string, draft: SlideDraft) =>
  apiFetch(
    `/api/decks/${encodeURIComponent(deckId)}/slides/${encodeURIComponent(slideId)}`,
    SaveSlideResponseSchema,
    { method: "PUT", body: JSON.stringify({ baseHash, draft }) },
  );

const deckUrl = (deckId: string) => `/api/decks/${encodeURIComponent(deckId)}`;

export const addSlide = (deckId: string, baseHash: string, afterSlideId: string | null, draft: SlideDraft) =>
  apiFetch(`${deckUrl(deckId)}/slides`, AddSlideResponseSchema, {
    method: "POST",
    body: JSON.stringify({ baseHash, afterSlideId, draft }),
  });

export const deleteSlide = (deckId: string, slideId: string, baseHash: string) =>
  apiFetch(
    `${deckUrl(deckId)}/slides/${encodeURIComponent(slideId)}?baseHash=${encodeURIComponent(baseHash)}`,
    StructureResponseSchema,
    { method: "DELETE" },
  );

export const reorderSlides = (deckId: string, slideIds: string[], baseHash: string) =>
  apiFetch(`${deckUrl(deckId)}/order`, StructureResponseSchema, {
    method: "PUT",
    body: JSON.stringify({ baseHash, slideIds }),
  });

export const presentDeck = (deckId: string, slideIndex: number) =>
  apiFetch(`${deckUrl(deckId)}/present`, PresentResponseSchema, {
    method: "POST",
    body: JSON.stringify({ slideIndex }),
  });

export const getExports = (deckId: string) => apiFetch(`${deckUrl(deckId)}/exports`, ExportsInfoSchema);

export const startExport = (deckId: string, request: ExportRequest) =>
  apiFetch(`${deckUrl(deckId)}/exports`, z.object({ jobId: z.string() }), {
    method: "POST",
    body: JSON.stringify(request),
  });

export const cancelJob = (jobId: string) =>
  apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, z.object({ job: ExportJobSchema }), {
    method: "DELETE",
  });

/**
 * Follows a job's server-sent events until it ends or `signal` aborts. EventSource can't send
 * the Studio token header, so this reads the stream through fetch.
 */
export async function followJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/events`, {
    headers: { [TOKEN_HEADER]: token() },
    signal,
  });
  if (!response.ok || !response.body)
    throw new ApiRequestError(response.status, { code: "JOB_NOT_FOUND", message: "The export is gone." });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JobEventSchema.parse(JSON.parse(data)));
    }
  }
}
