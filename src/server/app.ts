import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { streamSSE } from "hono/streaming";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { assetMime } from "@flipbook-md/core";
import {
  type AiTask,
  AddSlideRequestSchema,
  CreateDeckRequestSchema,
  ExportRequestSchema,
  CreateKitRequestSchema,
  KitPreviewRequestSchema,
  CopyGroupRequestSchema,
  CopyKitRequestSchema,
  DuplicateDeckRequestSchema,
  LlmModelsRequestSchema,
  LlmTestRequestSchema,
  SettingsPatchSchema,
  CreateProviderRequestSchema,
  UpdateProviderRequestSchema,
  RewriteRequestSchema,
  GenerateDeckRequestSchema,
  ImportDeckRequestSchema,
  SOURCE_MAX_BYTES,
  DraftKitRequestSchema,
  ChatRequestSchema,
  SaveAsRequestSchema,
  ApplyProposalRequestSchema,
  RenameGroupRequestSchema,
  KitQuerySchema,
  UpdateKitRequestSchema,
  PresentRequestSchema,
  type JobEvent,
  ASSET_MAX_BYTES,
  DeleteAssetQuerySchema,
  DeleteSlideQuerySchema,
  OrderRequestSchema,
  PreviewRequestSchema,
  SaveSlideRequestSchema,
  TOKEN_PLACEHOLDER,
  GitInitRequestSchema,
  SaveVersionRequestSchema,
  VersionsQuerySchema,
} from "../shared/api.js";
import { deckAssets, deleteAsset, uploadAsset } from "./assets.js";
import { StudioError } from "./errors.js";
import { DeckJournal } from "./journal.js";
import { checkApiRequest, checkHost } from "./guard.js";
import { coreExports, exportsInfo, startExport, type ExportServices } from "./exports.js";
import { JobRegistry } from "./jobs.js";
import { SettingsStore, configDir, maskSettings } from "./settings.js";
import { defaultProviderFactory, listModels, testConnection, type ProviderFactory } from "./llm/routes.js";
import { scrubKeys } from "./llm/keys.js";
import { addProvider, removeProvider, updateProvider } from "./providers.js";
import {
  copyGroup,
  copyKit,
  createKit,
  getKit,
  parseKind,
  previewKit,
  renameGroup,
  updateKit,
} from "./kits.js";
import { PlayerRegistry } from "./present.js";
import {
  addSlide,
  createWorkspaceDeck,
  deckDetail,
  deckFile,
  deleteSlide,
  duplicateWorkspaceDeck,
  findDeck,
  orderSlides,
  previewSlide,
  saveSlide,
  slideLabel,
  structureResult,
} from "./decks.js";
import { resolveInside } from "./paths.js";
import { scanWorkspace } from "./workspace.js";
import { importSource } from "./import.js";
import { SourceStore } from "./sources.js";
import { ProposalStore, applyProposal } from "./ai/proposals.js";
import { prepareRewrite, runRewrite } from "./ai/rewrite.js";
import { GenerationRuns, prepareGenerate, runGenerate } from "./ai/generate.js";
import { sseTask } from "./ai/sse.js";
import { prepareDraftKit, runDraftKit } from "./ai/draft-kit.js";
import { ChatSessionStore, runChat } from "./ai/chat.js";
import { resolveTaskLlm } from "./ai/resolve.js";
import { GitRunner } from "./history/git.js";
import { DeckHistoryService, gitFailure } from "./history/versions.js";
// US-26: restore a whole deck from a version.
import { DeckRestorer } from "./history/restore.js";
import { RestoreParamsSchema, RestoreRequestSchema } from "../shared/api.js";
import type { DeckEntry } from "./workspace.js";
// US-27: a past version's slides, their previews and files, and restoring one slide.
import { VersionCopies } from "./history/copies.js";
import { VersionSlides } from "./history/slides.js";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Room for multipart boundaries and headers around an 8 MB image. */
export const UPLOAD_OVERHEAD_BYTES = 64 * 1024;
/** How often expired uploaded sources are deleted (D24). */
const SOURCE_SWEEP_MS = 5 * 60 * 1000;

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; " +
  "font-src 'self' data: https: http:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const FILE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";

/** US-27: a version preview opened on its own gets the UI's CSP plus the preview iframe's sandbox. */
export const VERSION_PREVIEW_CSP = `${UI_CSP}; sandbox`;

const STATIC_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface AppOptions {
  workspace: string;
  library: string;
  token: string;
  /** The port the server listens on. A getter, because it is known only after binding. */
  port: () => number;
  uiDir: string;
  log?: (line: string) => void;
  /** Test seams for export (core's dependency check and exporters by default). */
  exportServices?: ExportServices;
  /** Settings (default: settings.json in the OS config folder). */
  settings?: SettingsStore;
  /** Test seam: how an LLM connection is made (default: OpenAI-compatible HTTP). */
  llmProvider?: ProviderFactory;
  /** US-23: how git runs (default: the git on PATH, with Studio's environment). */
  git?: GitRunner;
}

export type Env = { Variables: { requestId: string } };

function sendError(c: Context<Env>, error: StudioError, scrub?: (text: string) => string) {
  // US-21: a stored key never leaves in an error; the scrubber replaces it with its hint.
  const body = { error: error.toJSON() };
  return c.json(scrub ? (JSON.parse(scrub(JSON.stringify(body))) as typeof body) : body, error.status);
}

/** Maps typed errors to the envelope; anything else becomes 500 INTERNAL with the stack only in the log. */
export function errorHandler(log: (line: string) => void, scrub?: (text: string) => string) {
  return (error: Error, c: Context<Env>) => {
    if (error instanceof StudioError) return sendError(c, error, scrub);
    if (error instanceof ZodError) {
      return sendError(
        c,
        new StudioError(422, "VALIDATION_FAILED", "The request is not valid.", {
          details: {
            fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
        }),
        scrub,
      );
    }
    const requestId = c.get("requestId") ?? "-";
    log(`${requestId} INTERNAL ${error.stack ?? error.message}`);
    return sendError(c, new StudioError(500, "INTERNAL", `Something went wrong. Request ID: ${requestId}.`));
  };
}

async function jsonBody(c: Context<Env>): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new StudioError(422, "VALIDATION_FAILED", "The request body is not JSON.");
  });
}

export function createApp(options: AppOptions) {
  const rawLog = options.log ?? ((line: string) => console.log(line));
  // US-21: every log line and error passes through the key scrubber (security § Data protection).
  let storedKeys = (): string[] => [];
  const scrub = (text: string) => scrubKeys(text, storedKeys());
  const log = (line: string) => rawLog(scrub(line));
  const app = new Hono<Env>();
  const players = new PlayerRegistry();
  const jobs = new JobRegistry();
  const services = options.exportServices ?? coreExports;
  const settingsStore = options.settings
    ? Promise.resolve(options.settings)
    : SettingsStore.open(configDir(), log);
  settingsStore.then(
    (store) => (storedKeys = () => store.apiKeys()),
    () => {},
  );
  const llmProvider = options.llmProvider ?? defaultProviderFactory;
  const proposals = new ProposalStore();
  const generations = new GenerationRuns();
  const sources = new SourceStore();
  const sweep = setInterval(() => void sources.sweep(options.workspace).catch(() => {}), SOURCE_SWEEP_MS);
  sweep.unref();
  const chats = new ChatSessionStore();
  const journal = new DeckJournal();
  // US-23: version history. Git is checked once, at startup.
  const git = options.git ?? new GitRunner();
  void git.check();
  const versions = new DeckHistoryService({
    git,
    workspace: options.workspace,
    author: async () => (await settingsStore).current().git?.author,
  });
  const withGit = <T>(run: () => Promise<T>): Promise<T> =>
    run().catch((error: unknown) => {
      throw gitFailure(error, "GIT_COMMIT_FAILED");
    });
  /**
   * The model for an AI task (its own, else the default; US-19, D30) and its provider, local or
   * paid (US-24, no fallback), or 409 LLM_NOT_CONFIGURED / LLM_PROVIDER_MISSING before streaming.
   */
  const configuredLlm = async (task: AiTask) =>
    resolveTaskLlm((await settingsStore).current(), task, llmProvider);

  app.use("*", async (c, next) => {
    const requestId = crypto.randomBytes(4).toString("hex");
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    const started = Date.now();
    await next();
    log(
      `${requestId} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - started}ms`,
    );
  });

  // Every route checks Host (DNS rebinding). /api also needs Origin, Sec-Fetch-Site and the token.
  app.use("*", async (c, next) => {
    checkHost(c.req.raw.headers, options.port());
    await next();
  });

  // Deck files for preview iframes: Host-checked, GET only, no token (iframes cannot send headers).
  app.get("/api/decks/:id/files/*", async (c) => {
    const prefix = `/api/decks/${c.req.param("id")}/files/`;
    const raw = new URL(c.req.url).pathname.slice(prefix.length);
    let relative: string;
    try {
      relative = decodeURIComponent(raw);
    } catch {
      throw new StudioError(403, "PATH_OUTSIDE_ROOT", "File is outside the workspace.", { path: raw });
    }
    const file = await deckFile(options.workspace, c.req.param("id"), relative);
    const type = assetMime(file) ?? "application/octet-stream";
    return new Response(await fs.readFile(file), {
      headers: {
        "Content-Type": type,
        "Content-Security-Policy": FILE_CSP,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/decks/:id/files/*", () => {
    throw new StudioError(403, "FORBIDDEN_ORIGIN", "Preview files are read-only.");
  });

  // US-27: a past version's files, for version previews (D39). Like deck files: Host-checked,
  // GET only, no token; path-guarded inside the version copy.
  const versionCopies = new VersionCopies(options.workspace, git);
  app.get("/api/decks/:id/versions/:sha/files/*", async (c) => {
    const { sha } = RestoreParamsSchema.parse({ sha: c.req.param("sha") });
    const prefix = `/api/decks/${c.req.param("id")}/versions/${c.req.param("sha")}/files/`;
    const raw = new URL(c.req.url).pathname.slice(prefix.length);
    let relative: string;
    try {
      relative = decodeURIComponent(raw);
    } catch {
      throw new StudioError(403, "PATH_OUTSIDE_ROOT", "File is outside the version.", { path: raw });
    }
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const file = await withGit(() => versionCopies.file(deck, sha, relative));
    return new Response(await fs.readFile(file), {
      headers: {
        "Content-Type": assetMime(file) ?? "application/octet-stream",
        "Content-Security-Policy": FILE_CSP,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/decks/:id/versions/:sha/files/*", () => {
    throw new StudioError(403, "FORBIDDEN_ORIGIN", "Version files are read-only.");
  });

  const api = new Hono<Env>();
  api.use("*", async (c, next) => {
    checkApiRequest(c.req.raw.headers, options.port(), options.token);
    await next();
  });
  const smallBodies = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new StudioError(413, "PAYLOAD_TOO_LARGE", "Request body is larger than 2 MB.");
    },
  });
  // D20: an image upload is the only body allowed past 2 MB, checked while it streams in.
  const uploadBodies = bodyLimit({
    maxSize: ASSET_MAX_BYTES + UPLOAD_OVERHEAD_BYTES,
    onError: () => {
      throw new StudioError(413, "ASSET_TOO_LARGE", "Images can be at most 8 MB.");
    },
  });
  // D24: an uploaded source document (US-18) is the other one, up to 25 MB.
  const sourceBodies = bodyLimit({
    maxSize: SOURCE_MAX_BYTES + UPLOAD_OVERHEAD_BYTES,
    onError: () => {
      throw new StudioError(413, "SOURCE_TOO_LARGE", "Files can be at most 25 MB.");
    },
  });
  api.use("*", (c, next) => {
    if (c.req.method === "POST" && /^\/api\/decks\/[^/]+\/assets$/.test(c.req.path))
      return uploadBodies(c, next);
    if (c.req.method === "POST" && c.req.path === "/api/sources") return sourceBodies(c, next);
    return smallBodies(c, next);
  });
  api.get("/workspace", async (c) => c.json(await scanWorkspace(options.workspace, options.library)));
  api.get("/decks/:id", async (c) => c.json(await deckDetail(options.workspace, c.req.param("id"))));
  api.post("/decks/:id/preview", async (c) => {
    const { slideId, draft } = PreviewRequestSchema.parse(await jsonBody(c));
    return c.json(await previewSlide(options.workspace, c.req.param("id"), slideId, draft));
  });
  api.post("/decks/:id/slides", async (c) => {
    const { baseHash, afterSlideId, draft } = AddSlideRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const added = await journal.journaled(
      deck,
      (result) => (result ? `Add slide ${result.slide.index + 1}` : "Add slide"),
      () => addSlide(options.workspace, c.req.param("id"), afterSlideId, baseHash, draft),
    );
    return c.json(added, 201);
  });
  api.delete("/decks/:id/slides/:slideId{.+}", async (c) => {
    const { baseHash } = DeleteSlideQuerySchema.parse({ baseHash: c.req.query("baseHash") });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const label = await slideLabel(deck, c.req.param("slideId"), "Delete slide");
    return c.json(
      await journal.journaled(
        deck,
        () => label,
        () => deleteSlide(options.workspace, c.req.param("id"), c.req.param("slideId"), baseHash),
      ),
    );
  });
  // US-17: undo and redo.
  api.get("/decks/:id/history", async (c) =>
    c.json(journal.history(await findDeck(options.workspace, c.req.param("id")))),
  );
  for (const direction of ["undo", "redo"] as const) {
    api.post(`/decks/:id/${direction}`, async (c) => {
      const deck = await findDeck(options.workspace, c.req.param("id"));
      const history = await journal[direction](deck);
      const { slides, hashes, violations } = await structureResult(deck, c.req.param("id"));
      return c.json({ slides, hashes, violations, history });
    });
  }
  // US-23: version history (git).
  api.get("/decks/:id/versions", async (c) => {
    const { before, limit } = VersionsQuerySchema.parse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(await withGit(() => versions.list(deck, before, limit)));
  });
  api.post("/decks/:id/versions", async (c) => {
    const { note } = SaveVersionRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(await withGit(() => versions.save(deck, note)), 201);
  });
  api.post("/git/init", async (c) => {
    const { deckId, at } = GitInitRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, deckId);
    return c.json({ history: await withGit(() => versions.init(deck, at)) }, 201);
  });
  // US-26: restore a whole deck from a version, or discard its changes (D38). One journal step each.
  const restorer = new DeckRestorer({ git, versions, journal });
  const restored = async (id: string, run: (deck: DeckEntry) => Promise<{ skipped: unknown[] }>) => {
    const deck = await findDeck(options.workspace, id);
    const { skipped } = await withGit(() => run(deck));
    return {
      deck: await deckDetail(options.workspace, id),
      history: journal.history(deck),
      state: await withGit(() => versions.state(deck)),
      skipped,
    };
  };
  api.post("/decks/:id/versions/:sha/restore", async (c) => {
    const { sha } = RestoreParamsSchema.parse({ sha: c.req.param("sha") });
    const { expectHead } = RestoreRequestSchema.parse(await jsonBody(c));
    return c.json(await restored(c.req.param("id"), (deck) => restorer.restore(deck, sha, expectHead)));
  });
  api.post("/decks/:id/discard", async (c) => {
    const { expectHead } = RestoreRequestSchema.parse(await jsonBody(c));
    return c.json(await restored(c.req.param("id"), (deck) => restorer.discard(deck, expectHead)));
  });
  // US-27: a version's slides with their status, a slide's preview, and restoring one slide
  // (one journal step, no commit, no DECK_DIRTY check).
  const versionSlides = new VersionSlides({ versions, journal, copies: versionCopies });
  api.get("/decks/:id/versions/:sha", async (c) => {
    const { sha } = RestoreParamsSchema.parse({ sha: c.req.param("sha") });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(await withGit(() => versionSlides.view(deck, sha)));
  });
  api.get("/decks/:id/versions/:sha/slides/:slideId{.+}/preview", async (c) => {
    const { sha } = RestoreParamsSchema.parse({ sha: c.req.param("sha") });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const html = await withGit(() =>
      versionSlides.preview(deck, c.req.param("id"), sha, c.req.param("slideId")),
    );
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": VERSION_PREVIEW_CSP,
      "Cache-Control": "no-store",
    });
  });
  api.post("/decks/:id/versions/:sha/slides/:slideId{.+}/restore", async (c) => {
    const { sha } = RestoreParamsSchema.parse({ sha: c.req.param("sha") });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const result = await withGit(() => versionSlides.restore(deck, sha, c.req.param("slideId")));
    return c.json({
      deck: await deckDetail(options.workspace, c.req.param("id")),
      history: journal.history(deck),
      ...result,
    });
  });
  // US-16: deck images.
  // US-18: start a deck from an uploaded file.
  api.post("/sources", async (c) => {
    const form = await c.req.formData().catch(() => {
      throw new StudioError(422, "VALIDATION_FAILED", "Send the file as a multipart field named file.");
    });
    const file = form.get("file");
    if (!(file instanceof File))
      throw new StudioError(422, "VALIDATION_FAILED", "Send the file as a multipart field named file.", {
        details: { field: "file" },
      });
    if (file.size > SOURCE_MAX_BYTES)
      throw new StudioError(413, "SOURCE_TOO_LARGE", "Files can be at most 25 MB.");
    const source = await sources.save(options.workspace, file.name, Buffer.from(await file.arrayBuffer()));
    return c.json({ source }, 201);
  });
  api.post("/decks/import", async (c) => {
    const request = ImportDeckRequestSchema.parse(await jsonBody(c));
    return c.json(await importSource(options.workspace, sources, generations, request, log), 201);
  });
  api.get("/decks/:id/assets", async (c) => c.json(await deckAssets(options.workspace, c.req.param("id"))));
  api.post("/decks/:id/assets", async (c) => {
    const body = await c.req.parseBody().catch(() => {
      throw new StudioError(422, "VALIDATION_FAILED", "Send the image as multipart/form-data.");
    });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    const uploaded = await journal.journaled(
      deck,
      (result) => `Upload ${result?.asset.path.replace(/^assets\//, "") ?? "image"}`,
      () => uploadAsset(options.workspace, c.req.param("id"), body.file),
    );
    return c.json(uploaded, 201);
  });
  api.delete("/decks/:id/assets/:path{.+}", async (c) => {
    const { force } = DeleteAssetQuerySchema.parse({ force: c.req.query("force") });
    const deck = await findDeck(options.workspace, c.req.param("id"));
    await journal.journaled(
      deck,
      () => `Delete image ${c.req.param("path")}`,
      () => deleteAsset(options.workspace, c.req.param("id"), `assets/${c.req.param("path")}`, force === "1"),
    );
    return c.body(null, 204);
  });
  api.put("/decks/:id/order", async (c) => {
    const { baseHash, slideIds } = OrderRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(
      await journal.journaled(
        deck,
        () => "Reorder slides",
        () => orderSlides(options.workspace, c.req.param("id"), slideIds, baseHash),
      ),
    );
  });
  // Folder slide IDs contain slashes ("slides/01.slide.md"); the client percent-encodes them.
  api.put("/decks/:id/slides/:slideId{.+}", async (c) => {
    const { baseHash, draft } = SaveSlideRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(
      await journal.journaled(
        deck,
        (result) => (result ? `Edit slide ${result.slide.index + 1}` : "Edit slide"),
        () => saveSlide(options.workspace, c.req.param("id"), c.req.param("slideId"), baseHash, draft),
      ),
    );
  });
  api.post("/decks", async (c) => {
    const created = await createWorkspaceDeck(
      options.workspace,
      CreateDeckRequestSchema.parse(await jsonBody(c)),
    );
    return c.json(await deckDetail(options.workspace, created.id), 201);
  });
  // US-20: duplicate a deck beside itself.
  api.post("/decks/:id/duplicate", async (c) =>
    c.json(
      await duplicateWorkspaceDeck(
        options.workspace,
        c.req.param("id"),
        DuplicateDeckRequestSchema.parse(await jsonBody(c)),
      ),
      201,
    ),
  );
  // US-7: kits.
  api.post("/kits/:kind/preview", async (c) => {
    const kind = parseKind(c.req.param("kind"));
    return c.json(
      await previewKit(options.workspace, kind, KitPreviewRequestSchema.parse(await jsonBody(c))),
    );
  });
  api.get("/kits/:kind/:name", async (c) => {
    const kind = parseKind(c.req.param("kind"));
    const { scope, deckId } = KitQuerySchema.parse({
      scope: c.req.query("scope"),
      deckId: c.req.query("deckId"),
    });
    return c.json(await getKit(options.workspace, kind, c.req.param("name"), scope, deckId));
  });
  // US-11: settings and the local LLM.
  api.get("/settings", async (c) => c.json(maskSettings((await settingsStore).current())));
  api.put("/settings", async (c) => {
    const patch = SettingsPatchSchema.parse(await jsonBody(c));
    return c.json(maskSettings(await (await settingsStore).update(patch)));
  });
  // US-21: paid providers. Responses carry the key only as a hint; task models are never touched.
  api.post("/providers", async (c) =>
    c.json(await addProvider(await settingsStore, CreateProviderRequestSchema.parse(await jsonBody(c))), 201),
  );
  api.patch("/providers/:id", async (c) =>
    c.json(
      await updateProvider(
        await settingsStore,
        c.req.param("id"),
        UpdateProviderRequestSchema.parse(await jsonBody(c)),
      ),
    ),
  );
  api.delete("/providers/:id", async (c) => {
    await removeProvider(await settingsStore, c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/llm/models", async (c) =>
    c.json(
      await listModels(
        LlmModelsRequestSchema.parse(await jsonBody(c)),
        await settingsStore,
        llmProvider,
        c.req.raw.signal,
      ),
    ),
  );
  api.post("/llm/test", async (c) =>
    c.json(
      await testConnection(
        LlmTestRequestSchema.parse(await jsonBody(c)),
        await settingsStore,
        llmProvider,
        c.req.raw.signal,
      ),
    ),
  );
  // US-12: AI rewrite and proposals.
  api.post("/ai/rewrite", async (c) => {
    const request = RewriteRequestSchema.parse(await jsonBody(c));
    const { llm, provider, task, providerInfo: info, failure } = await configuredLlm("rewrite");
    const prepared = await prepareRewrite(options.workspace, request);
    return sseTask(
      c.req.raw,
      (context) => runRewrite(context, prepared, request, { provider, llm, store: proposals, log }),
      { log, baseUrl: llm.baseUrl, model: llm.model, task, scrub, provider: info, failure },
    );
  });
  // US-13: generate a deck. Checks that can answer with plain JSON run before the stream opens.
  api.post("/ai/generate-deck", async (c) => {
    const request = GenerateDeckRequestSchema.parse(await jsonBody(c));
    const { llm, provider, task, providerInfo: info, failure } = await configuredLlm("generate");
    const prepared = await prepareGenerate(options.workspace, request, sources);
    return sseTask(
      c.req.raw,
      (context) =>
        runGenerate(context, options.workspace, request, prepared, {
          provider,
          llm,
          runs: generations,
          sources,
          log,
        }),
      { log, baseUrl: llm.baseUrl, model: llm.model, task, scrub, provider: info, failure },
    );
  });
  api.post("/ai/generate-deck/:runId/save-as", async (c) => {
    const { name } = SaveAsRequestSchema.parse(await jsonBody(c));
    return c.json(await generations.saveAs(options.workspace, c.req.param("runId"), name), 201);
  });
  // US-14: draft a kit piece. Name checks answer with plain JSON before the stream opens.
  api.post("/ai/draft-kit", async (c) => {
    const request = DraftKitRequestSchema.parse(await jsonBody(c));
    const { llm, provider, task, providerInfo: info, failure } = await configuredLlm("draft");
    const prepared = await prepareDraftKit(options.workspace, options.library, request);
    return sseTask(
      c.req.raw,
      (context) => runDraftKit(context, prepared, request, { provider, llm, store: proposals, log }),
      { log, baseUrl: llm.baseUrl, model: llm.model, task, scrub, provider: info, failure },
    );
  });
  // US-15: chat about a deck. One stream per deck; the session lives in memory only.
  api.post("/ai/chat", async (c) => {
    const request = ChatRequestSchema.parse(await jsonBody(c));
    const { llm, provider, task, providerInfo: info, failure } = await configuredLlm("chat");
    await findDeck(options.workspace, request.deckId);
    const session = chats.open(request.deckId, request.sessionId);
    chats.begin(request.deckId);
    return sseTask(
      c.req.raw,
      async (context) => {
        try {
          return await runChat(context, options.workspace, request, session, {
            provider,
            llm,
            sessions: chats,
            store: proposals,
            log,
          });
        } finally {
          chats.end(request.deckId);
        }
      },
      { log, baseUrl: llm.baseUrl, model: llm.model, task, scrub, provider: info, failure },
    );
  });
  api.post("/proposals/:id/apply", async (c) => {
    const { opIds } = ApplyProposalRequestSchema.parse(await jsonBody(c));
    const stored = proposals.get(c.req.param("id"));
    const apply = () => applyProposal(options.workspace, proposals, c.req.param("id"), opIds);
    // Kit-only proposals (no deck) change the library, which has no undo (US-17 scope).
    if (!stored.deckId) return c.json(await apply());
    const deck = await findDeck(options.workspace, stored.deckId);
    return c.json(await journal.journaled(deck, () => `AI: ${stored.summary}`, apply));
  });
  api.delete("/proposals/:id", (c) => {
    proposals.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  // US-10: copy and rename media kits.
  api.post("/kits/group/:name/copy", async (c) =>
    c.json(
      await copyGroup(
        options.workspace,
        c.req.param("name"),
        CopyGroupRequestSchema.parse(await jsonBody(c)),
      ),
      201,
    ),
  );
  // US-20: copy any library or built-in kit piece.
  api.post("/kits/:kind/:name/copy", async (c) =>
    c.json(
      await copyKit(
        options.workspace,
        parseKind(c.req.param("kind")),
        c.req.param("name"),
        CopyKitRequestSchema.parse(await jsonBody(c)),
      ),
      201,
    ),
  );
  api.post("/kits/group/:name/rename", async (c) =>
    c.json(
      await renameGroup(
        options.workspace,
        c.req.param("name"),
        RenameGroupRequestSchema.parse(await jsonBody(c)),
      ),
    ),
  );
  api.post("/kits/:kind", async (c) => {
    const kind = parseKind(c.req.param("kind"));
    return c.json(
      await createKit(options.workspace, kind, CreateKitRequestSchema.parse(await jsonBody(c))),
      201,
    );
  });
  api.put("/kits/:kind/:name", async (c) => {
    const kind = parseKind(c.req.param("kind"));
    const request = UpdateKitRequestSchema.parse(await jsonBody(c));
    return c.json(await updateKit(options.workspace, kind, c.req.param("name"), request));
  });
  // US-6: present and export.
  api.post("/decks/:id/present", async (c) => {
    const { slideIndex = 0 } = PresentRequestSchema.parse(await jsonBody(c));
    const deck = await findDeck(options.workspace, c.req.param("id"));
    return c.json(await players.open(c.req.param("id"), deck, slideIndex));
  });
  api.get("/decks/:id/exports", async (c) =>
    c.json(await exportsInfo(options.workspace, c.req.param("id"), jobs)),
  );
  api.post("/decks/:id/exports", async (c) => {
    const request = ExportRequestSchema.parse(await jsonBody(c));
    const job = await startExport(options.workspace, c.req.param("id"), request, jobs, services);
    return c.json({ jobId: job.id }, 202);
  });
  api.get("/jobs/:jobId/events", (c) => {
    const id = c.req.param("jobId");
    if (!jobs.get(id)) throw new StudioError(404, "JOB_NOT_FOUND", "No export with that ID.");
    // Replays the current state, then streams until the job ends. Closing the stream never stops the job.
    return streamSSE(c, async (stream) => {
      const queue: JobEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = jobs.subscribe(id, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      queue.unshift(...jobs.replay(id));
      try {
        for (;;) {
          while (queue.length) {
            const event = queue.shift()!;
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            if (event.type !== "progress") return;
          }
          if (stream.aborted) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        unsubscribe();
      }
    });
  });
  api.delete("/jobs/:jobId", (c) => {
    const job = jobs.cancel(c.req.param("jobId"));
    if (!job) throw new StudioError(404, "JOB_NOT_FOUND", "No export with that ID.");
    return c.json({ job });
  });
  // Last: anything else under /api.
  api.all("*", () => {
    throw new StudioError(404, "NOT_FOUND", "No such API route.");
  });
  app.route("/api", api);

  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    // Vite's bundle lives under /assets/. Every other path is a client route (slide IDs end in .md).
    if (pathname.startsWith("/assets/")) {
      const file = await resolveInside(options.uiDir, decodeURIComponent(pathname.slice(1))).catch(
        () => null,
      );
      const body = file ? await fs.readFile(file).catch(() => null) : null;
      if (!body) return c.text("Not found", 404);
      return new Response(body, {
        headers: {
          "Content-Type": STATIC_TYPES[path.extname(file!)] ?? "application/octet-stream",
          "Cache-Control": "no-cache",
        },
      });
    }
    // Client-side routes all get the UI shell, with this launch's token in a meta tag.
    const shell = await fs.readFile(path.join(options.uiDir, "index.html"), "utf8");
    c.header("Content-Security-Policy", UI_CSP);
    c.header("Cache-Control", "no-store");
    return c.html(shell.replace(TOKEN_PLACEHOLDER, options.token));
  });

  app.onError(errorHandler(log, scrub));

  /** Stops player servers and cancels running exports (Studio is shutting down). */
  const shutdown = async () => {
    clearInterval(sweep);
    jobs.cancelAll();
    await players.closeAll();
  };
  return Object.assign(app, { shutdown, players, jobs, git });
}
