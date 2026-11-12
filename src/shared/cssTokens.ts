/** A CSS custom property declaration found in theme source. */
export interface CssToken {
  /** Stable key: selector, name and occurrence, so the same token in two rules is edited separately. */
  id: string;
  name: string;
  value: string;
  selector: string;
  /** Character offsets of the value (trimmed) in the source. */
  start: number;
  end: number;
}

/** Replaces comments and string contents with spaces, keeping every offset. */
function mask(css: string): string {
  let out = "";
  let index = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const close = css.indexOf("*/", index + 2);
      const end = close === -1 ? css.length : close + 2;
      out += css.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
    } else if (css[index] === '"' || css[index] === "'") {
      const quote = css[index]!;
      let end = index + 1;
      while (end < css.length && css[end] !== quote && css[end] !== "\n") end += css[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, css.length);
      out +=
        quote + css.slice(index + 1, end - 1).replace(/[^\n]/g, " ") + (end - 1 > index ? css[end - 1] : "");
      index = end;
    } else {
      out += css[index];
      index += 1;
    }
  }
  return out;
}

/** Every `--name: value` declaration, in source order, with the selector of its rule. */
export function parseTokens(css: string): CssToken[] {
  const masked = mask(css);
  const tokens: CssToken[] = [];
  const stack: string[] = [];
  const seen = new Map<string, number>();
  let segmentStart = 0;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char === "{") {
      stack.push(masked.slice(segmentStart, index).trim().replace(/\s+/g, " "));
      segmentStart = index + 1;
    } else if (char === "}") {
      stack.pop();
      segmentStart = index + 1;
    } else if (char === ";") {
      segmentStart = index + 1;
    } else if (
      char === "-" &&
      masked[index + 1] === "-" &&
      stack.length &&
      masked.slice(segmentStart, index).trim() === ""
    ) {
      const match = /^--[A-Za-z0-9_-]+/.exec(masked.slice(index));
      const colon = match ? masked.indexOf(":", index + match[0].length) : -1;
      if (match && colon !== -1 && masked.slice(index + match[0].length, colon).trim() === "") {
        let end = colon + 1;
        let depth = 0;
        while (end < masked.length) {
          const next = masked[end];
          if (next === "(") depth += 1;
          else if (next === ")") depth -= 1;
          else if ((next === ";" || next === "}") && depth <= 0) break;
          end += 1;
        }
        let start = colon + 1;
        while (start < end && /\s/.test(css[start]!)) start += 1;
        let stop = end;
        while (stop > start && /\s/.test(css[stop - 1]!)) stop -= 1;
        const selector = stack.join(" › ");
        const key = `${selector}|${match[0]}`;
        const occurrence = seen.get(key) ?? 0;
        seen.set(key, occurrence + 1);
        tokens.push({
          id: `${key}|${occurrence}`,
          name: match[0],
          value: css.slice(start, stop),
          selector,
          start,
          end: stop,
        });
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return tokens;
}

/** The source with only `token`'s value replaced. */
export function replaceToken(css: string, token: CssToken, value: string): string {
  return css.slice(0, token.start) + value + css.slice(token.end);
}

/** A hex color input value (#rrggbb) for a token value, or null when it isn't a plain hex color. */
export function hexColor(value: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
  return `#${hex.toLowerCase()}`;
}

export const isFontToken = (token: CssToken) => /font/i.test(token.name);

/** A cheap syntax check: unbalanced braces or parentheses, or an unclosed comment or string. */
export function cssWarning(css: string): string | null {
  const open = css.lastIndexOf("/*");
  if (open !== -1 && css.indexOf("*/", open + 2) === -1) return "A comment is not closed (missing */).";
  const masked = mask(css);
  if (/(["'])[^"'\n]*$/m.test(masked.replace(/(["'])\s*\1/g, ""))) return "A string is not closed.";
  let braces = 0;
  let parens = 0;
  for (const char of masked) {
    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    if (braces < 0) return "There is a } without a matching {.";
  }
  if (braces > 0) return "A { is not closed.";
  if (parens !== 0) return "Parentheses don't match.";
  return null;
}
