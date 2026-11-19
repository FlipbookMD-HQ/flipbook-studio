/**
 * One fixture format for both LLM test doubles (FakeProvider and the HTTP stub, D14).
 * A chat fixture says what the model "answers"; a status fixture makes the server fail.
 */
export type LlmFixture =
  | { kind: "text"; text: string; usage?: { prompt: number; completion: number } }
  | { kind: "json"; value: unknown }
  | { kind: "invalidJson" }
  | { kind: "slowTokens"; ms: number; text: string }
  | { kind: "hang" }
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "hostile" }
  /** US-21: a 302 to another host (the client must refuse it). */
  | { kind: "redirect"; location: string }
  /** US-21: a captive portal or proxy page instead of the API. */
  | { kind: "html" };

export interface LlmScript {
  /**
   * Model ids for /v1/models (default ["stub-model"]), or a status fixture to fail with. An object
   * entry is sent as-is (US-21: capability fields such as OpenRouter's `architecture`).
   */
  models?: (string | { id: string; [field: string]: unknown })[] | Extract<LlmFixture, { kind: "status" }>;
  /** Chat answers, consumed in order (the last one repeats), or chosen per request. */
  chat?:
    | LlmFixture[]
    | ((request: { model: string; messages: { role: string; content: string }[] }) => LlmFixture);
  /** Answer 400 "response_format is not supported" when a request sends response_format. */
  rejectResponseFormat?: boolean;
  /** Require `Authorization: Bearer <apiKey>`; anything else gets 401. */
  apiKey?: string;
  /** US-21: answer 400 "stream_options is not supported" when a request sends stream_options. */
  rejectStreamOptions?: boolean;
}

/** What a hostile model proposes: path traversal, script tags and ops on slides that don't exist. */
export const HOSTILE_OUTPUT = {
  ops: [
    {
      id: "op1",
      kind: "writeKitFile",
      kit: { kind: "theme", name: "../../../etc/passwd", scope: "library" },
      source: "body{}",
    },
    {
      id: "op2",
      kind: "updateSlide",
      slideId: "no-such-slide",
      draft: { markdown: '<script>alert("x")</script>' },
    },
    {
      id: "op3",
      kind: "addSlide",
      afterSlideId: "../../outside",
      draft: { markdown: "# Hi <img src=x onerror=alert(1)>" },
    },
  ],
};

/** The text a chat fixture streams, split into the tokens it is sent as. */
export function fixtureTokens(fixture: LlmFixture): string[] {
  const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];
  switch (fixture.kind) {
    case "text":
    case "slowTokens":
      return words(fixture.text);
    case "json":
      return words(JSON.stringify(fixture.value));
    case "invalidJson":
      return words('{"ops": [ {"kind": "updateSlide", "draft": ');
    case "hostile":
      return words(JSON.stringify(HOSTILE_OUTPUT));
    default:
      return [];
  }
}

/** The chat fixture for a request: the next scripted one, or the script's choice. */
export function nextChatFixture(
  script: LlmScript,
  index: number,
  request: { model: string; messages: { role: string; content: string }[] },
): LlmFixture {
  if (typeof script.chat === "function") return script.chat(request);
  const list = script.chat ?? [{ kind: "text", text: "ready" }];
  return list[Math.min(index, list.length - 1)]!;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    // Already aborted: an abort event will never come, so reject now (as fetch does).
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    });
  });
