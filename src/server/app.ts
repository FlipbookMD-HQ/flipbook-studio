import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { streamSSE } from "hono/streaming";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { assetMime } from "@flipbook-md/core";
import {
  AddSlideRequestSchema,
  CreateDeckRequestSchema,
  ExportRequestSchema,
  CreateKitRequestSchema,
  KitPreviewRequestSchema,
  CopyGroupRequestSchema,
  RenameGroupRequestSchema,
  KitQuerySchema,
  UpdateKitRequestSchema,
  PresentRequestSchema,
  type JobEvent,
  DeleteSlideQuerySchema,
  OrderRequestSchema,
  PreviewRequestSchema,
  SaveSlideRequestSchema,
  TOKEN_PLACEHOLDER,
} from "../shared/api.js";
import { StudioError } from "./errors.js";
import { checkApiRequest, checkHost } from "./guard.js";
import { coreExports, exportsInfo, startExport, type ExportServices } from "./exports.js";
import { JobRegistry } from "./jobs.js";
import { copyGroup, createKit, getKit, parseKind, previewKit, renameGroup, updateKit } from "./kits.js";
import { PlayerRegistry } from "./present.js";
import {
  addSlide,
  createWorkspaceDeck,
  deckDetail,
  deckFile,
  deleteSlide,
  findDeck,
  orderSlides,
  previewSlide,
  saveSlide,
} from "./decks.js";
import { resolveInside } from "./paths.js";
import { scanWorkspace } from "./workspace.js";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; " +
  "font-src 'self' data: https: http:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const FILE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";

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
}

export type Env = { Variables: { requestId: string } };

function sendError(c: Context<Env>, error: StudioError) {
  return c.json({ error: error.toJSON() }, error.status);
}

/** Maps typed errors to the envelope; anything else becomes 500 INTERNAL with the stack only in the log. */
export function errorHandler(log: (line: string) => void) {
  return (error: Error, c: Context<Env>) => {
    if (error instanceof StudioError) return sendError(c, error);
    if (error instanceof ZodError) {
      return sendError(
        c,
        new StudioError(422, "VALIDATION_FAILED", "The request is not valid.", {
          details: {
            fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
        }),
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
  const log = options.log ?? ((line: string) => console.log(line));
  const app = new Hono<Env>();
  const players = new PlayerRegistry();
  const jobs = new JobRegistry();
  const services = options.exportServices ?? coreExports;

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
      headers: { "Content-Type": type, "Content-Security-Policy": FILE_CSP, "Cache-Control": "no-store" },
    });
  });
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/decks/:id/files/*", () => {
    throw new StudioError(403, "FORBIDDEN_ORIGIN", "Preview files are read-only.");
  });

  const api = new Hono<Env>();
  api.use("*", async (c, next) => {
    checkApiRequest(c.req.raw.headers, options.port(), options.token);
    await next();
  });
  api.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new StudioError(413, "PAYLOAD_TOO_LARGE", "Request body is larger than 2 MB.");
      },
    }),
  );
  api.get("/workspace", async (c) => c.json(await scanWorkspace(options.workspace, options.library)));
  api.get("/decks/:id", async (c) => c.json(await deckDetail(options.workspace, c.req.param("id"))));
  api.post("/decks/:id/preview", async (c) => {
    const { slideId, draft } = PreviewRequestSchema.parse(await jsonBody(c));
    return c.json(await previewSlide(options.workspace, c.req.param("id"), slideId, draft));
  });
  api.post("/decks/:id/slides", async (c) => {
    const { baseHash, afterSlideId, draft } = AddSlideRequestSchema.parse(await jsonBody(c));
    return c.json(await addSlide(options.workspace, c.req.param("id"), afterSlideId, baseHash, draft), 201);
  });
  api.delete("/decks/:id/slides/:slideId{.+}", async (c) => {
    const { baseHash } = DeleteSlideQuerySchema.parse({ baseHash: c.req.query("baseHash") });
    return c.json(await deleteSlide(options.workspace, c.req.param("id"), c.req.param("slideId"), baseHash));
  });
  api.put("/decks/:id/order", async (c) => {
    const { baseHash, slideIds } = OrderRequestSchema.parse(await jsonBody(c));
    return c.json(await orderSlides(options.workspace, c.req.param("id"), slideIds, baseHash));
  });
  // Folder slide IDs contain slashes ("slides/01.slide.md"); the client percent-encodes them.
  api.put("/decks/:id/slides/:slideId{.+}", async (c) => {
    const { baseHash, draft } = SaveSlideRequestSchema.parse(await jsonBody(c));
    return c.json(
      await saveSlide(options.workspace, c.req.param("id"), c.req.param("slideId"), baseHash, draft),
    );
  });
  api.post("/decks", async (c) => {
    const created = await createWorkspaceDeck(
      options.workspace,
      CreateDeckRequestSchema.parse(await jsonBody(c)),
    );
    return c.json(await deckDetail(options.workspace, created.id), 201);
  });
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

  app.onError(errorHandler(log));

  /** Stops player servers and cancels running exports (Studio is shutting down). */
  const shutdown = async () => {
    jobs.cancelAll();
    await players.closeAll();
  };
  return Object.assign(app, { shutdown, players, jobs });
}
