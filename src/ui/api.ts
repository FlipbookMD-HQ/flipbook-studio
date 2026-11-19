import {
  HistorySchema,
  UndoResponseSchema,
  DeckAssetsResponseSchema,
  UploadAssetResponseSchema,
  type CreateDeckRequest,
  DeckDetailSchema,
  AddSlideResponseSchema,
  ExportJobSchema,
  KitDocSchema,
  DuplicateDeckResponseSchema,
  type DuplicateDeckRequest,
  type CopyKitRequest,
  KitPreviewResponseSchema,
  RenameGroupResponseSchema,
  SettingsSchema,
  LlmModelsResponseSchema,
  LlmTestResponseSchema,
  type SettingsPatch,
  type LlmModelsRequest,
  type LlmTestRequest,
  type CopyGroupRequest,
  type RenameGroupRequest,
  type CreateKitRequest,
  type KitKind,
  type KitScope,
  type UpdateKitRequest,
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
  ApplyProposalResponseSchema,
  type RewriteRequest,
  type Proposal,
  type Violation,
  type ChatRequest,
  type DraftKitRequest,
  type GenerateDeckRequest,
  ImportDeckResponseSchema,
  SourceDocumentSchema,
  type ImportDeckRequest,
  VersionsResponseSchema,
  SaveVersionResponseSchema,
  GitInitResponseSchema,
  type GitInitRequest,
} from "../shared/api";
import { z } from "zod";
import { DECK_WRITTEN, isDeckWrite } from "./undo";

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
  // A FormData body sets its own multipart content type (with the boundary).
  if (init.body != null && !(init.body instanceof FormData) && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(body);
    throw new ApiRequestError(
      response.status,
      envelope.success
        ? envelope.data.error
        : { code: "INTERNAL", message: `Request failed with ${response.status}.` },
    );
  }
  // US-17: any deck write may add an undo step.
  if (isDeckWrite(init.method ?? "GET", url) && typeof window !== "undefined")
    window.dispatchEvent(new Event(DECK_WRITTEN));
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

const kitUrl = (kind: KitKind, name: string, scope: KitScope, deckId?: string) =>
  `/api/kits/${kind}/${encodeURIComponent(name)}?scope=${scope}${deckId ? `&deckId=${encodeURIComponent(deckId)}` : ""}`;

export const getKit = (kind: KitKind, name: string, scope: KitScope, deckId?: string) =>
  apiFetch(kitUrl(kind, name, scope, deckId), KitDocSchema);

export const createKit = (kind: KitKind, request: CreateKitRequest) =>
  apiFetch(`/api/kits/${kind}`, KitDocSchema, { method: "POST", body: JSON.stringify(request) });

export const updateKit = (kind: KitKind, name: string, request: UpdateKitRequest) =>
  apiFetch(`/api/kits/${kind}/${encodeURIComponent(name)}`, KitDocSchema, {
    method: "PUT",
    body: JSON.stringify(request),
  });

export const previewKit = (
  kind: KitKind,
  request: { source: string; deckId?: string; scope?: "library" | "builtin"; name?: string },
  signal?: AbortSignal,
) =>
  apiFetch(`/api/kits/${kind}/preview`, KitPreviewResponseSchema, {
    method: "POST",
    body: JSON.stringify(request),
    signal,
  });

// US-10: media kits.
export const copyGroup = (name: string, request: CopyGroupRequest) =>
  apiFetch(`/api/kits/group/${encodeURIComponent(name)}/copy`, KitDocSchema, {
    method: "POST",
    body: JSON.stringify(request),
  });
export const renameGroup = (name: string, request: RenameGroupRequest) =>
  apiFetch(`/api/kits/group/${encodeURIComponent(name)}/rename`, RenameGroupResponseSchema, {
    method: "POST",
    body: JSON.stringify(request),
  });

// US-20: duplicate decks and kit pieces.
export const duplicateDeck = (deckId: string, request: DuplicateDeckRequest) =>
  apiFetch(`/api/decks/${deckId}/duplicate`, DuplicateDeckResponseSchema, {
    method: "POST",
    body: JSON.stringify(request),
  });
export const copyKit = (kind: KitKind, name: string, request: CopyKitRequest) =>
  apiFetch(`/api/kits/${kind}/${encodeURIComponent(name)}/copy`, KitDocSchema, {
    method: "POST",
    body: JSON.stringify(request),
  });

// US-11: settings and the local LLM.
export const getSettings = () => apiFetch("/api/settings", SettingsSchema);
export const putSettings = (patch: SettingsPatch) =>
  apiFetch("/api/settings", SettingsSchema, { method: "PUT", body: JSON.stringify(patch) });
export const listLlmModels = (request: LlmModelsRequest, signal?: AbortSignal) =>
  apiFetch("/api/llm/models", LlmModelsResponseSchema, {
    method: "POST",
    body: JSON.stringify(request),
    signal,
  });
export const testLlm = (request: LlmTestRequest) =>
  apiFetch("/api/llm/test", LlmTestResponseSchema, { method: "POST", body: JSON.stringify(request) });

/** One event of an AI stream (US-12 to US-15). */
export type AiEvent =
  | { event: "token"; data: { text: string } }
  | { event: "notice"; data: { message: string } }
  | { event: "proposal"; data: Proposal }
  | { event: "slide"; data: { index: number; draft: SlideDraft } }
  | { event: "repair"; data: { round: number; violations: Violation[] } }
  | {
      event: "done";
      data: {
        noChange?: boolean;
        deckId?: string;
        violations?: Violation[];
        sessionId?: string;
        model?: string;
      };
    }
  | { event: "failed"; data: { error: ApiError } };

/**
 * POSTs to an AI endpoint and reads its server-sent events until `done` or `failed`. A non-stream
 * error answer (409 LLM_NOT_CONFIGURED, 422…) throws ApiRequestError before any event.
 */
export async function streamAi(
  url: string,
  body: unknown,
  onEvent: (event: AiEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { [TOKEN_HEADER]: token(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const envelope = ErrorEnvelopeSchema.safeParse(await response.json().catch(() => null));
    throw new ApiRequestError(
      response.status,
      envelope.success
        ? envelope.data.error
        : { code: "INTERNAL", message: `Request failed with ${response.status}.` },
    );
  }
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
      const event = /^event: ?(.*)$/m.exec(block)?.[1] ?? "message";
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      onEvent({ event, data: data ? JSON.parse(data) : null } as AiEvent);
    }
  }
}

export const rewriteSlide = (
  request: RewriteRequest,
  onEvent: (event: AiEvent) => void,
  signal: AbortSignal,
) => streamAi("/api/ai/rewrite", request, onEvent, signal);

export const applyProposal = (id: string, opIds: string[]) =>
  apiFetch(`/api/proposals/${encodeURIComponent(id)}/apply`, ApplyProposalResponseSchema, {
    method: "POST",
    body: JSON.stringify({ opIds }),
  });

export async function discardProposal(id: string): Promise<void> {
  await fetch(`/api/proposals/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { [TOKEN_HEADER]: token() },
  });
}

export const generateDeck = (
  request: GenerateDeckRequest,
  onEvent: (event: AiEvent) => void,
  signal: AbortSignal,
) => streamAi("/api/ai/generate-deck", request, onEvent, signal);

export const draftKit = (request: DraftKitRequest, onEvent: (event: AiEvent) => void, signal: AbortSignal) =>
  streamAi("/api/ai/draft-kit", request, onEvent, signal);

export const chatDeck = (request: ChatRequest, onEvent: (event: AiEvent) => void, signal: AbortSignal) =>
  streamAi("/api/ai/chat", request, onEvent, signal);

export const saveGeneratedDeck = (runId: string, name: string) =>
  apiFetch(`/api/ai/generate-deck/${encodeURIComponent(runId)}/save-as`, z.object({ deckId: z.string() }), {
    method: "POST",
    body: JSON.stringify({ name }),
  });

// US-18: start a deck from an uploaded file.
export const uploadSource = (file: File) => {
  const form = new FormData();
  form.append("file", file);
  return apiFetch("/api/sources", z.object({ source: SourceDocumentSchema }), { method: "POST", body: form });
};
export const importDeck = (request: ImportDeckRequest) =>
  apiFetch("/api/decks/import", ImportDeckResponseSchema, { method: "POST", body: JSON.stringify(request) });

// US-16: deck images.
const assetsUrl = (deckId: string) => `/api/decks/${encodeURIComponent(deckId)}/assets`;
export const listAssets = (deckId: string) => apiFetch(assetsUrl(deckId), DeckAssetsResponseSchema);
export const uploadAsset = (deckId: string, file: File) => {
  const form = new FormData();
  form.append("file", file);
  return apiFetch(assetsUrl(deckId), UploadAssetResponseSchema, { method: "POST", body: form });
};
export const deleteAsset = (deckId: string, assetPath: string, force = false) =>
  apiFetch(
    `${assetsUrl(deckId)}/${assetPath
      .replace(/^assets\//, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${force ? "?force=1" : ""}`,
    z.undefined(),
    { method: "DELETE" },
  );
/** The URL an <img> shows a deck image from (Host-checked, no token needed). */
export const assetUrl = (deckId: string, assetPath: string) =>
  `/api/decks/${encodeURIComponent(deckId)}/files/${assetPath.split("/").map(encodeURIComponent).join("/")}`;

// US-17: undo and redo.
export const getHistory = (deckId: string) =>
  apiFetch(`/api/decks/${encodeURIComponent(deckId)}/history`, HistorySchema);
export const undoDeck = (deckId: string, direction: "undo" | "redo") =>
  apiFetch(`/api/decks/${encodeURIComponent(deckId)}/${direction}`, UndoResponseSchema, { method: "POST" });

// US-23: version history (git).
export const getVersions = (deckId: string, before: string | null = null) =>
  apiFetch(
    `${deckUrl(deckId)}/versions${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    VersionsResponseSchema,
  );
export const saveVersion = (deckId: string, note: string) =>
  apiFetch(`${deckUrl(deckId)}/versions`, SaveVersionResponseSchema, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
export const initGit = (deckId: string, at: GitInitRequest["at"]) =>
  apiFetch("/api/git/init", GitInitResponseSchema, { method: "POST", body: JSON.stringify({ deckId, at }) });
