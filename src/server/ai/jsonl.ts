import { z } from "zod";
import { StudioError } from "../errors.js";

/** One slide as the model writes it: one JSON object per line (D15). */
export const SlideLineSchema = z.object({
  type: z.string().trim().max(60).nullable().optional(),
  template: z.string().trim().max(60).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  markdown: z.string().trim().min(1, "markdown is empty").max(50_000),
  notes: z.string().max(20_000).optional(),
});
export type SlideLine = z.infer<typeof SlideLineSchema>;

export const MAX_INVALID_LINES = 2;

/**
 * Reads a JSON Lines answer as it streams. Partial lines are buffered; lines that don't start
 * with `{` are chatter and skipped; lines that start with `{` but aren't a valid slide count as
 * invalid. More than two invalid lines, or no valid slide at the end, is LLM_BAD_OUTPUT.
 */
export class JsonLinesParser<T = SlideLine> {
  private buffer = "";
  private valid = 0;
  readonly problems: string[] = [];

  constructor(private readonly schema: z.ZodType<T> = SlideLineSchema as unknown as z.ZodType<T>) {}

  /** Feeds a chunk; returns the items completed by it. */
  push(chunk: string): T[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.line(line));
  }

  /** Flushes the last line and checks that at least one item arrived. */
  end(): T[] {
    const last = this.line(this.buffer);
    this.buffer = "";
    if (this.valid === 0) {
      throw new StudioError(502, "LLM_BAD_OUTPUT", "The model didn't return any slides.", {
        details: { problems: this.problems },
      });
    }
    return last;
  }

  get count() {
    return this.valid;
  }

  private line(raw: string): T[] {
    const text = raw.trim().replace(/,$/, "");
    if (!text.startsWith("{")) return []; // Chatter, blank lines and code fences.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return this.invalid(`Line isn't valid JSON (${(error as Error).message}).`);
    }
    const result = this.schema.safeParse(parsed);
    if (!result.success)
      return this.invalid(
        result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      );
    this.valid += 1;
    return [result.data];
  }

  private invalid(problem: string): T[] {
    this.problems.push(problem);
    if (this.problems.length > MAX_INVALID_LINES) {
      throw new StudioError(
        502,
        "LLM_BAD_OUTPUT",
        `The model's answer had too many unusable lines. ${problem}`,
        {
          details: { problems: this.problems },
        },
      );
    }
    return [];
  }
}
