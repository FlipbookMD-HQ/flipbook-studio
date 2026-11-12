import { describe, expect, it } from "vitest";
import { JsonLinesParser } from "../src/server/ai/jsonl.js";

const line = (markdown: string, type = "point") => JSON.stringify({ type, markdown });

describe("JsonLinesParser", () => {
  it("joins a line split across chunks", () => {
    const parser = new JsonLinesParser();
    const text = `${line("# One")}\n${line("# Two")}\n`;
    const out = [
      ...parser.push(text.slice(0, 10)),
      ...parser.push(text.slice(10, 40)),
      ...parser.push(text.slice(40)),
    ];
    expect(out.map((item) => item.markdown)).toEqual(["# One", "# Two"]);
    expect(parser.end()).toEqual([]);
  });

  it("skips chatter before and after, and code fences", () => {
    const parser = new JsonLinesParser();
    const out = parser.push(
      `Sure! Here is your deck:\n\`\`\`jsonl\n${line("# One")}\n\`\`\`\nHope this helps.`,
    );
    expect(out).toHaveLength(1);
    expect(parser.end()).toEqual([]);
    expect(parser.problems).toEqual([]);
  });

  it("skips one bad line and keeps going; the last line needs no newline", () => {
    const parser = new JsonLinesParser();
    const out = parser.push(
      `${line("# One")}\n{"type": "point", "markdown": \n${line("")}\n${line("# Two")}`,
    );
    expect(out).toHaveLength(1);
    expect(parser.end().map((item) => item.markdown)).toEqual(["# Two"]);
    expect(parser.problems).toHaveLength(2);
  });

  it("fails with LLM_BAD_OUTPUT on the third bad line", () => {
    const parser = new JsonLinesParser();
    expect(() => parser.push(`${line("# One")}\n{bad\n{"markdown": 3}\n{"nope": true}\n`)).toThrow(
      expect.objectContaining({ code: "LLM_BAD_OUTPUT" }),
    );
  });

  it("fails with LLM_BAD_OUTPUT when no slide arrives", () => {
    const parser = new JsonLinesParser();
    parser.push("I can't help with that.");
    expect(() => parser.end()).toThrow(expect.objectContaining({ code: "LLM_BAD_OUTPUT" }));
    expect(() => new JsonLinesParser().end()).toThrow(expect.objectContaining({ code: "LLM_BAD_OUTPUT" }));
  });
});
