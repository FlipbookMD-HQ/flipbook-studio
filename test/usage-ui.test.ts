import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiProvider, ProviderView, UsageResponse } from "../src/shared/api.js";
import { NO_RUN_USAGE, UsageNote, endUsage, formatTokens, trackUsage, type RunUsage } from "../src/ui/ai.js";
import type { AiEvent } from "../src/ui/api.js";
import { ProvidersSection, SessionUsage } from "../src/ui/screens/ProvidersSection.js";

// US-25 · 1.1.2: the token display, rendered to static markup.
const OPENAI: AiProvider = { id: "openai", label: "OpenAI", kind: "openai" };
const LOCAL: AiProvider = { id: "local", label: "Local", kind: "local" };
const note = (run: RunUsage) => renderToStaticMarkup(createElement(UsageNote, { run }));
const run = (events: AiEvent[], from: RunUsage = NO_RUN_USAGE) => events.reduce(trackUsage, from);
const start = (provider: AiProvider): AiEvent => ({ event: "start", data: { provider, model: "m" } });
const PRICE = /\$|€|£|price|cost|usd|estimat/i;

describe("formatTokens", () => {
  it("says N in · M out tokens, with thousands separators", () => {
    expect(formatTokens({ input: 1234, output: 56 })).toBe("1,234 in · 56 out tokens");
    expect(formatTokens({ input: 0, output: 0 })).toBe("0 in · 0 out tokens");
  });
});

describe("trackUsage", () => {
  it("follows a paid run from start through progress to done", () => {
    let state = run([start(OPENAI)]);
    expect(state).toEqual({ provider: OPENAI, usage: null, ended: false });
    state = run([{ event: "usage", data: { usage: { input: 10, output: 1 } } }], state);
    expect(state).toEqual({ provider: OPENAI, usage: { input: 10, output: 1 }, ended: false });
    state = run([{ event: "done", data: { provider: OPENAI, usage: { input: 10, output: 40 } } }], state);
    expect(state).toEqual({ provider: OPENAI, usage: { input: 10, output: 40 }, ended: true });
  });

  it("takes failed's usage, null included", () => {
    const failed = run([
      start(OPENAI),
      { event: "usage", data: { usage: { input: 3, output: 0 } } },
      { event: "failed", data: { error: { code: "LLM_BAD_OUTPUT", message: "x" }, usage: null } },
    ]);
    expect(failed).toEqual({ provider: OPENAI, usage: null, ended: true });
  });

  it("keeps what was reported before a cancel from the panel", () => {
    const progress = run([start(OPENAI), { event: "usage", data: { usage: { input: 9, output: 2 } } }]);
    expect(endUsage(progress)).toEqual({ provider: OPENAI, usage: { input: 9, output: 2 }, ended: true });
    expect(endUsage(run([start(OPENAI)]))).toEqual({ provider: OPENAI, usage: null, ended: true });
    // A run that never started has nothing to show.
    expect(endUsage(NO_RUN_USAGE)).toBe(NO_RUN_USAGE);
  });

  it("starts over on the next run's start", () => {
    const first = run([start(OPENAI), { event: "done", data: { usage: { input: 1, output: 1 } } }]);
    expect(run([start(LOCAL)], first)).toEqual({ provider: LOCAL, usage: null, ended: false });
  });
});

describe("UsageNote", () => {
  it("shows a paid run's tokens once it ends", () => {
    const html = note({ provider: OPENAI, usage: { input: 1200, output: 340 }, ended: true });
    expect(html).toContain('data-testid="ai-usage"');
    expect(html).toContain("1,200 in · 340 out tokens");
    expect(html).not.toMatch(PRICE);
  });

  it('says "usage not reported" when the provider sent none, never an estimate', () => {
    const html = note({ provider: OPENAI, usage: null, ended: true });
    expect(html).toContain("usage not reported");
    expect(html).not.toMatch(/\d/);
  });

  it("shows nothing for local runs, runs still going, or no run", () => {
    expect(note({ provider: LOCAL, usage: { input: 5, output: 5 }, ended: true })).toBe("");
    expect(note({ provider: OPENAI, usage: { input: 5, output: 5 }, ended: false })).toBe("");
    expect(note(NO_RUN_USAGE)).toBe("");
    expect(note(endUsage(NO_RUN_USAGE))).toBe("");
  });
});

const USAGE: UsageResponse = {
  since: "2026-11-19T10:00:00.000Z",
  totals: [
    {
      providerId: "openai",
      label: "OpenAI",
      kind: "openai",
      requests: 3,
      input: 4_500,
      output: 900,
      unreported: 0,
    },
    {
      providerId: "openrouter",
      label: "openrouter",
      kind: "openai-compatible",
      requests: 1,
      input: 0,
      output: 0,
      unreported: 1,
    },
  ],
};
const openai: ProviderView = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeyHint: "sk-…c3d4",
};
const noop = () => {};

describe("SessionUsage", () => {
  it("lists tokens and requests per provider, and what wasn't reported", () => {
    const html = renderToStaticMarkup(createElement(SessionUsage, { usage: USAGE }));
    expect(html).toContain("Tokens this session");
    expect(html).toMatch(/data-testid="usage-openai".*OpenAI.*4,500 in · 900 out tokens.*3 requests/);
    expect(html).toMatch(/data-testid="usage-openrouter".*1 request ·.*1 with usage not reported/);
    expect(html).toContain("Resets when Studio restarts.");
    expect(html).not.toMatch(PRICE);
  });

  it("says so when there were no paid requests yet", () => {
    const html = renderToStaticMarkup(
      createElement(SessionUsage, { usage: { since: USAGE.since, totals: [] } }),
    );
    expect(html).toContain("No paid requests since Studio started.");
  });
});

describe("ProvidersSection with usage", () => {
  it("shows the session totals under the providers", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersSection, { providers: [openai], onChange: noop, usage: USAGE }),
    );
    expect(html).toContain('data-testid="session-usage"');
    expect(html).toContain("4,500 in · 900 out tokens");
  });

  it("shows no totals without paid providers or usage", () => {
    const html = renderToStaticMarkup(createElement(ProvidersSection, { providers: [], onChange: noop }));
    expect(html).not.toContain("session-usage");
  });

  it("keeps totals of a provider removed this session", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersSection, { providers: [], onChange: noop, usage: USAGE }),
    );
    expect(html).toContain("4,500 in · 900 out tokens");
  });
});
