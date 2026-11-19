/**
 * Recorded Anthropic Messages API traffic (US-21, D33), replayed by the fake Anthropic server.
 * The shapes follow the API's documented event stream and error bodies (anthropic-version 2023-06-01).
 */

/** A streamed reply as recorded: message_start, ping, text deltas, message_delta with usage, message_stop. */
export const RECORDED_REPLY = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01XFDUDYJgAACzvnptvVoYEL","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ready"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}

`;

/** A stream the server breaks off with an overloaded error event after the first delta. */
export const RECORDED_OVERLOADED_STREAM = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01Overloaded","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":18,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Rea"}}

event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

`;

/** A text reply in the recorded format, split into one delta per word. */
export function recordedText(text: string, usage = { input: 12, output: 5 }): string {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_01Fake",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-fake",
        stop_reason: null,
        usage: { input_tokens: usage.input, output_tokens: 1 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ...words.map((word) =>
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: word },
      }),
    ),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

const errorBody = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } });

/** Recorded error answers, by what they mean. */
export const RECORDED_ERRORS = {
  unauthorized: { status: 401, body: errorBody("authentication_error", "invalid x-api-key") },
  forbidden: {
    status: 403,
    body: errorBody(
      "permission_error",
      "Your API key does not have permission to use the specified resource.",
    ),
  },
  notFound: { status: 404, body: errorBody("not_found_error", "model: claude-nope") },
  rateLimited: {
    status: 429,
    body: errorBody("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"),
    headers: { "retry-after": "17" },
  },
  overloaded: { status: 529, body: errorBody("overloaded_error", "Overloaded") },
  noCredit: {
    status: 400,
    body: errorBody(
      "invalid_request_error",
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    ),
  },
  badRequest: { status: 400, body: errorBody("invalid_request_error", "messages: field required") },
} as const;

/** A recorded /v1/models page. */
export const RECORDED_MODELS = [
  {
    type: "model",
    id: "claude-opus-4-1-20250805",
    display_name: "Claude Opus 4.1",
    created_at: "2025-08-05T00:00:00Z",
  },
  {
    type: "model",
    id: "claude-sonnet-4-5",
    display_name: "Claude Sonnet 4.5",
    created_at: "2025-09-29T00:00:00Z",
  },
  {
    type: "model",
    id: "claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-01T00:00:00Z",
  },
];
