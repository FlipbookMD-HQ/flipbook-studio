import http from "node:http";
import type { AddressInfo } from "node:net";
import { fixtureTokens, nextChatFixture, sleep, type LlmScript } from "./llm-fixtures.js";

export interface StubRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

export interface LlmStub {
  /** The base URL, ending in /v1. */
  url: string;
  /** Every request received, in order. */
  requests: StubRequest[];
  setScript(script: LlmScript): void;
  close(): Promise<void>;
}

/**
 * A tiny OpenAI-compatible server for tests (D14): GET /v1/models and streaming
 * POST /v1/chat/completions, answering from an LlmScript. Binds 127.0.0.1 on port 0.
 */
export async function startLlmStub({ script: initial = {} }: { script?: LlmScript } = {}): Promise<LlmStub> {
  let script = initial;
  let chats = 0;
  const requests: StubRequest[] = [];
  const open = new Set<http.ServerResponse>();

  const fail = (
    res: http.ServerResponse,
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    // A body that is already JSON (a recorded provider error) is sent as recorded.
    res.end(/^\s*\{/.test(message) ? message : JSON.stringify({ error: { message } }));
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });

    if (script.apiKey && req.headers.authorization !== `Bearer ${script.apiKey}`)
      return fail(res, 401, "Invalid API key");

    if (req.method === "GET" && path === "/v1/models") {
      const models = script.models ?? ["stub-model"];
      if (!Array.isArray(models))
        return fail(res, models.status, models.body ?? `status ${models.status}`, models.headers);
      res.writeHead(200, { "content-type": "application/json" });
      const data = models.map((model) =>
        typeof model === "string" ? { id: model, object: "model" } : model,
      );
      return res.end(JSON.stringify({ object: "list", data }));
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (script.rejectResponseFormat && body && "response_format" in body)
        return fail(res, 400, "response_format is not supported by this server");
      if (script.rejectStreamOptions && body && "stream_options" in body)
        return fail(res, 400, "Unrecognized request argument supplied: stream_options");
      const fixture = nextChatFixture(script, chats++, {
        model: String(body?.model ?? ""),
        messages: (body?.messages as { role: string; content: string }[]) ?? [],
      });
      if (fixture.kind === "status")
        return fail(res, fixture.status, fixture.body ?? `status ${fixture.status}`, fixture.headers);
      if (fixture.kind === "redirect") {
        res.writeHead(302, { location: fixture.location });
        return res.end();
      }
      if (fixture.kind === "html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>Sign in to the Wi-Fi</title>");
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      open.add(res);
      res.on("close", () => open.delete(res));
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      try {
        if (fixture.kind === "hang") {
          await sleep(10 * 60_000, abort.signal);
          return;
        }
        const tokens = fixtureTokens(fixture);
        for (const token of tokens) {
          if (fixture.kind === "slowTokens") await sleep(fixture.ms, abort.signal);
          res.write(
            `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: token } }] })}\n\n`,
          );
        }
        const usage = fixture.kind === "text" ? fixture.usage : undefined;
        res.write(
          `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage ? { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } } : {}) })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } catch {
        // The client went away.
      }
      return;
    }
    fail(res, 404, `No route ${req.method} ${path}`);
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
