import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fit } from "../src/server/ai/budget.js";
import { sseTask } from "../src/server/ai/sse.js";
import { stripFence, structuredCall } from "../src/server/ai/structured.js";
import { FakeProvider } from "./support/fake-provider.js";
import { sleep } from "./support/llm-fixtures.js";
import { sseEvents } from "./support/sse.js";

const Answer = z.object({ markdown: z.string().min(1) });
const call = (provider: FakeProvider, logs: string[] = [], signal = new AbortController().signal) =>
  structuredCall({
    provider,
    model: "m",
    messages: [{ role: "user", content: "SECRET PROMPT" }],
    schema: Answer,
    signal,
    log: (line) => logs.push(line),
  });

afterEach(() => {
  delete process.env.FLIPBOOK_DEBUG;
});

describe("structuredCall", () => {
  it("returns valid JSON on the first try", async () => {
    const provider = new FakeProvider({ chat: [{ kind: "json", value: { markdown: "# Hi" } }] });
    expect(await call(provider)).toEqual({ markdown: "# Hi" });
    expect(provider.requests).toHaveLength(1);
  });

  it("retries once with the validation error, then succeeds", async () => {
    const provider = new FakeProvider({
      chat: [
        { kind: "json", value: { wrong: 1 } },
        { kind: "json", value: { markdown: "# Fixed" } },
      ],
    });
    expect(await call(provider)).toEqual({ markdown: "# Fixed" });
    const retry = provider.requests[1]!.messages.at(-1)!.content;
    expect(retry).toMatch(/markdown: Required/);
  });

  it("fails with LLM_BAD_OUTPUT after two invalid answers", async () => {
    const provider = new FakeProvider({ chat: [{ kind: "invalidJson" }] });
    await expect(call(provider)).rejects.toMatchObject({
      code: "LLM_BAD_OUTPUT",
      details: { raw: expect.any(String) },
    });
    expect(provider.requests).toHaveLength(2);
  });

  it("strips a code fence before validating", async () => {
    const provider = new FakeProvider({
      chat: [{ kind: "text", text: '```json\n{"markdown": "# Fenced"}\n```' }],
    });
    expect(await call(provider)).toEqual({ markdown: "# Fenced" });
    expect(stripFence("```\n{}\n```")).toBe("{}");
  });

  it("keeps prompts out of the log unless FLIPBOOK_DEBUG=ai", async () => {
    const logs: string[] = [];
    await call(new FakeProvider({ chat: [{ kind: "json", value: { markdown: "x" } }] }), logs);
    expect(logs.join("\n")).not.toContain("SECRET PROMPT");
    process.env.FLIPBOOK_DEBUG = "ai";
    await call(new FakeProvider({ chat: [{ kind: "json", value: { markdown: "x" } }] }), logs);
    expect(logs.join("\n")).toContain("SECRET PROMPT");
  });
});

describe("sseTask", () => {
  it("ends with exactly one done", async () => {
    const response = sseTask(new Request("http://x/"), async ({ send }) => {
      send("token", { text: "a" });
      return { ok: true };
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(await sseEvents(response)).toEqual([
      { event: "token", data: { text: "a" } },
      { event: "done", data: { ok: true } },
    ]);
  });

  it("ends with exactly one failed carrying the mapped error", async () => {
    const provider = new FakeProvider({ chat: [{ kind: "status", status: 401 }] });
    const response = sseTask(
      new Request("http://x/"),
      async ({ signal }) => {
        await call(provider, [], signal);
      },
      { baseUrl: "http://127.0.0.1:11434/v1" },
    );
    const events = await sseEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "failed", data: { error: { code: "LLM_UNAUTHORIZED" } } });
  });

  it("aborts the LLM request within 100 ms of a disconnect", async () => {
    const client = new AbortController();
    let aborted = 0;
    const response = sseTask(new Request("http://x/", { signal: client.signal }), async ({ signal }) => {
      signal.addEventListener("abort", () => (aborted = Date.now()));
      await call(new FakeProvider({ chat: [{ kind: "hang" }] }), [], signal);
    });
    const reader = response.body!.getReader();
    await sleep(20);
    const started = Date.now();
    client.abort();
    await sleep(100);
    expect(aborted).toBeGreaterThan(0);
    expect(aborted - started).toBeLessThan(100);
    const rest = await reader.read().then(async (first) => {
      let text = first.value ? new TextDecoder().decode(first.value) : "";
      for (let next = await reader.read(); !next.done; next = await reader.read())
        text += new TextDecoder().decode(next.value);
      return text;
    });
    expect(rest).toContain('"code":"CANCELLED"');
  });
});

describe("contextBudget.fit", () => {
  it("drops the least important parts first and reports trimming", () => {
    const parts = [
      { name: "task", priority: 0, text: "t".repeat(100) },
      { name: "rules", priority: 1, text: "r".repeat(100) },
      { name: "notes", priority: 2, text: "n".repeat(100) },
      { name: "deck", priority: 3, text: "d".repeat(100) },
    ];
    // 100 tokens → 80% → 320 characters: the deck part goes first.
    expect(fit(parts, 100)).toEqual({ parts: parts.slice(0, 3), trimmed: true });
    expect(fit(parts, 70).parts.map((part) => part.name)).toEqual(["task", "rules"]);
    expect(fit(parts, 1).parts.map((part) => part.name)).toEqual(["task"]);
    expect(fit(parts, 8192)).toEqual({ parts, trimmed: false });
  });
});
