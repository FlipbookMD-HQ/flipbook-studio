import http from "node:http";
import type { AddressInfo } from "node:net";
import { RECORDED_MODELS, RECORDED_REPLY } from "./anthropic-fixtures.js";
import { sleep } from "./llm-fixtures.js";
import type { StubRequest } from "./llm-stub.js";

/** What the fake Anthropic server answers a request with. */
export type AnthropicReply =
  /** A recorded event stream, replayed as is. */
  | { kind: "stream"; events: string; delayMs?: number }
  | { kind: "status"; status: number; body: string; headers?: Readonly<Record<string, string>> }
  | { kind: "redirect"; location: string }
  | { kind: "html" }
  | { kind: "hang" };

export interface AnthropicScript {
  /** The key the server accepts in `x-api-key`; anything else gets a recorded 401. */
  apiKey?: string;
  /** Models for /v1/models (default RECORDED_MODELS), or a failure. */
  models?: Record<string, unknown>[] | Extract<AnthropicReply, { kind: "status" | "redirect" | "html" }>;
  /** Models per /v1/models page (pagination with `after_id`). Default: all on one page. */
  pageSize?: number;
  /** Replies to POST /v1/messages, in order (the last repeats), or chosen per request. */
  chat?: AnthropicReply[] | ((body: Record<string, unknown>) => AnthropicReply);
}

export interface AnthropicStub {
  /** The base URL, ending in /v1. */
  url: string;
  requests: StubRequest[];
  setScript(script: AnthropicScript): void;
  close(): Promise<void>;
}

/**
 * A fake Anthropic API for tests (US-21): `GET /v1/models` and streamed `POST /v1/messages`,
 * replaying recorded traffic. Binds 127.0.0.1 on port 0; never talks to the real service.
 */
export async function startAnthropicStub(initial: AnthropicScript = {}): Promise<AnthropicStub> {
  let script = initial;
  let chats = 0;
  const requests: StubRequest[] = [];
  const open = new Set<http.ServerResponse>();

  const reply = async (res: http.ServerResponse, answer: AnthropicReply) => {
    switch (answer.kind) {
      case "status":
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
        return res.end(answer.body);
      case "redirect":
        res.writeHead(302, { location: answer.location });
        return res.end();
      case "html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>Sign in to the Wi-Fi</title>");
      case "hang": {
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        await sleep(10 * 60_000, abort.signal).catch(() => {});
        return;
      }
      case "stream": {
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        try {
          for (const event of answer.events.split(/(?<=\n\n)/)) {
            if (answer.delayMs) await sleep(answer.delayMs, abort.signal);
            res.write(event);
          }
          res.end();
        } catch {
          // The client went away.
        }
        return;
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, body });

    if (script.apiKey && req.headers["x-api-key"] !== script.apiKey)
      return reply(res, {
        kind: "status",
        status: 401,
        body: JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = script.models ?? RECORDED_MODELS;
      if (!Array.isArray(models)) return reply(res, models);
      const after = url.searchParams.get("after_id");
      const start = after ? models.findIndex((model) => model.id === after) + 1 : 0;
      const size = script.pageSize ?? models.length;
      const page = models.slice(start, start + size);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          data: page,
          has_more: start + size < models.length,
          first_id: page[0]?.id ?? null,
          last_id: page.at(-1)?.id ?? null,
        }),
      );
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const list = script.chat ?? [{ kind: "stream", events: RECORDED_REPLY }];
      const answer = typeof list === "function" ? list(body ?? {}) : list[Math.min(chats, list.length - 1)]!;
      chats++;
      return reply(res, answer);
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Not found" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setScript(next) {
      script = next;
      chats = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
