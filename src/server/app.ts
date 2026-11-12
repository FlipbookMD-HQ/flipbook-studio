import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { assetMime } from "@flipbook-md/core";
import { CreateDeckRequestSchema, TOKEN_PLACEHOLDER } from "../shared/api.js";
import { StudioError } from "./errors.js";
import { checkApiRequest, checkHost } from "./guard.js";
import { createWorkspaceDeck, deckDetail, deckFile } from "./decks.js";
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

export function createApp(options: AppOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const app = new Hono<Env>();

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
  api.post("/decks", async (c) => {
    const body: unknown = await c.req.json().catch(() => {
      throw new StudioError(422, "VALIDATION_FAILED", "The request body is not JSON.");
    });
    const created = await createWorkspaceDeck(options.workspace, CreateDeckRequestSchema.parse(body));
    return c.json(await deckDetail(options.workspace, created.id), 201);
  });
  api.all("*", () => {
    throw new StudioError(404, "NOT_FOUND", "No such API route.");
  });
  app.route("/api", api);

  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname !== "/" && path.extname(pathname)) {
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

  return app;
}
