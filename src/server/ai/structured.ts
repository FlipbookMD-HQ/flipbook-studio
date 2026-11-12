import type { z } from "zod";
import { StudioError } from "../errors.js";
import type { ChatMessage, LlmProvider } from "../llm/provider.js";

/** AI prompts and replies reach the log only with FLIPBOOK_DEBUG=ai (security: data protection). */
export const aiDebug = () => /(^|,)\s*ai\s*(,|$)/.test(process.env.FLIPBOOK_DEBUG ?? "");

/** The text without a surrounding Markdown code fence (```json … ```), trimmed. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (match ? match[1]! : trimmed).trim();
}

/** Why `text` isn't a valid answer, or the parsed value. */
function check<T>(text: string, schema: z.ZodType<T>): { value: T } | { problem: string } {
  const body = stripFence(text);
  if (!body) return { problem: "The answer was empty." };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return { problem: `The answer wasn't valid JSON (${(error as Error).message}).` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { value: result.data };
  return {
    problem: `The JSON didn't match the schema: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}.`,
  };
}

export interface StructuredCall<T> {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** Sent as response_format when the server supports it. */
  jsonSchema?: object;
  temperature?: number;
  signal: AbortSignal;
  onToken?: (text: string) => void;
  log?: (line: string) => void;
}

/**
 * Asks for JSON and validates it with zod (D7). One retry inside the request feeds the problem
 * back to the model; a second failure throws LLM_BAD_OUTPUT with the raw reply in details.
 */
export async function structuredCall<T>(call: StructuredCall<T>): Promise<T> {
  const log = call.log ?? (() => {});
  let messages = call.messages;
  let raw = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (aiDebug()) log(`ai prompt (attempt ${attempt}): ${JSON.stringify(messages)}`);
    raw = "";
    for await (const event of call.provider.chat({
      model: call.model,
      messages,
      temperature: call.temperature,
      jsonSchema: call.jsonSchema,
      signal: call.signal,
    })) {
      if (event.type === "delta") {
        raw += event.text;
        call.onToken?.(event.text);
      }
    }
    if (aiDebug()) log(`ai reply (attempt ${attempt}): ${raw}`);
    const result = check(raw, call.schema);
    if ("value" in result) return result.value;
    if (attempt === 2) {
      throw new StudioError(502, "LLM_BAD_OUTPUT", `The model's answer wasn't usable. ${result.problem}`, {
        details: { raw: raw.slice(0, 20_000) },
      });
    }
    messages = [
      ...call.messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `${result.problem} Reply again with only the JSON object, matching the schema exactly. No code fence, no comments.`,
      },
    ];
  }
  throw new Error("unreachable");
}
