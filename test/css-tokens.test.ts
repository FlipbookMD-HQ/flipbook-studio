import { describe, expect, it } from "vitest";
import { cssWarning, hexColor, parseTokens, replaceToken } from "../src/shared/cssTokens.js";

describe("parseTokens", () => {
  it("finds tokens with any spacing, keeping the exact value span", () => {
    const css = ":root {\n  --accent: #fff;\n  --bg:#000;\n  --line :  red  ;\n}";
    const tokens = parseTokens(css);
    expect(tokens.map((token) => [token.name, token.value])).toEqual([
      ["--accent", "#fff"],
      ["--bg", "#000"],
      ["--line", "red"],
    ]);
    for (const token of tokens) expect(css.slice(token.start, token.end)).toBe(token.value);
  });

  it("keeps values with commas, var() and nested parentheses whole", () => {
    const css =
      ':root{--font: "Inter", system-ui, sans-serif;--glow:0 0 4px rgb(0 0 0 / 50%), var(--x, #fff);--last:1px}';
    expect(parseTokens(css).map((token) => token.value)).toEqual([
      '"Inter", system-ui, sans-serif',
      "0 0 4px rgb(0 0 0 / 50%), var(--x, #fff)",
      "1px",
    ]);
  });

  it("treats the same token in different selectors as separate tokens", () => {
    const css =
      ":root { --accent: #111; }\n.dark { --accent: #222; }\n@media (min-width: 1px) { :root { --accent: #333; } }";
    const tokens = parseTokens(css);
    expect(tokens.map((token) => token.selector)).toEqual([
      ":root",
      ".dark",
      "@media (min-width: 1px) › :root",
    ]);
    expect(new Set(tokens.map((token) => token.id)).size).toBe(3);
    const edited = replaceToken(css, tokens[1]!, "#abc");
    expect(edited).toBe(css.replace("#222", "#abc"));
  });

  it("ignores declarations in comments and strings, and keeps comments when editing", () => {
    const css =
      '/* --old: #000; */\n:root {\n  /* brand */\n  --accent: #f05; /* main */\n  --label: "--fake: 1";\n}\n';
    const tokens = parseTokens(css);
    expect(tokens.map((token) => token.name)).toEqual(["--accent", "--label"]);
    const edited = replaceToken(css, tokens[0]!, "#0f8");
    expect(edited).toBe(css.replace("#f05", "#0f8"));
    expect(edited).toContain("/* brand */");
    expect(edited).toContain("/* main */");
  });

  it("does not take property values that merely contain -- as tokens", () => {
    expect(parseTokens(".a { color: var(--accent); margin: -2px; }")).toEqual([]);
  });
});

describe("helpers", () => {
  it("converts hex colors for the color picker", () => {
    expect(hexColor("#FFF")).toBe("#ffffff");
    expect(hexColor(" #12ab9C ")).toBe("#12ab9c");
    expect(hexColor("rgb(0 0 0)")).toBeNull();
  });

  it("warns about broken CSS", () => {
    expect(cssWarning(":root { --a: 1; }")).toBeNull();
    expect(cssWarning(":root { --a: 1;")).toMatch(/not closed/);
    expect(cssWarning(":root { --a: 1; }}")).toMatch(/without a matching/);
    expect(cssWarning("/* open")).toMatch(/comment/);
    expect(cssWarning(".a { b: calc(1px + 2px; }")).toMatch(/Parentheses/);
    expect(cssWarning('.a::before { content: "}"; }')).toBeNull();
  });
});
