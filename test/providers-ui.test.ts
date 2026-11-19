import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderView } from "../src/shared/api.js";
import { modelMark } from "../src/ui/modelMarks.js";
import {
  AddProviderForm,
  ProviderCard,
  ProvidersSection,
  addableKinds,
  testSummary,
} from "../src/ui/screens/ProvidersSection.js";

// US-21 · 1.2.1: component tests for Settings → Providers, rendered to static markup.
const claude: ProviderView = {
  id: "anthropic",
  kind: "anthropic",
  label: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKeyHint: "sk-…a1b2",
};
const router: ProviderView = {
  id: "openrouter",
  kind: "openai-compatible",
  label: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyHint: "sk-…e5f6",
};
const noop = () => {};

/** Every <input type="password"> in the markup, with its value attribute (if any). */
const passwordInputs = (html: string) =>
  [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((match) => match[0]);

describe("ProviderCard", () => {
  it("shows the key only as its hint, with no key field until Replace key", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, { provider: claude, onChanged: noop, onRemoved: noop }),
    );
    expect(html).toContain("Key sk-…a1b2");
    expect(html).toContain("Anthropic (Claude)");
    expect(html).toContain("https://api.anthropic.com/v1");
    expect(html).toContain("Replace key");
    expect(html).toContain(">Remove<");
    expect(html).toContain("List models");
    expect(passwordInputs(html)).toEqual([]);
  });
});

describe("AddProviderForm", () => {
  it("starts with an empty key field and asks for a base URL only for Other", () => {
    const html = renderToStaticMarkup(
      createElement(AddProviderForm, { providers: [], onAdded: noop, onCancel: noop }),
    );
    const keys = passwordInputs(html);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toMatch(/value="[^"]+"/);
    expect(html).toContain("Anthropic (Claude)");
    expect(html).toContain("OpenAI");
    expect(html).toContain("Other (OpenAI-compatible)");
    // Anthropic is chosen first: no base URL field.
    expect(html).not.toContain("Base URL");
    expect(html).toContain("Enter the API key.");
  });

  it("offers each fixed kind once, and Other any number of times", () => {
    expect(addableKinds([])).toEqual(["anthropic", "openai", "openai-compatible"]);
    expect(addableKinds([claude, router])).toEqual(["openai", "openai-compatible"]);
    const html = renderToStaticMarkup(
      createElement(AddProviderForm, { providers: [claude], onAdded: noop, onCancel: noop }),
    );
    const anthropicRadio = /<label class="choice"><input[^>]*>Anthropic \(Claude\)/.exec(html)![0];
    expect(anthropicRadio).toContain("disabled");
    expect(/<label class="choice"><input[^>]*>OpenAI</.exec(html)![0]).toContain("checked");
  });

  it("shows the base URL field when Other is the only kind left", () => {
    const openai: ProviderView = { ...claude, id: "openai", kind: "openai", label: "OpenAI" };
    const html = renderToStaticMarkup(
      createElement(AddProviderForm, { providers: [claude, openai], onAdded: noop, onCancel: noop }),
    );
    expect(html).toContain("Base URL");
  });
});

describe("ProvidersSection", () => {
  it("lists every provider by its hint, and says when there are none", () => {
    const html = renderToStaticMarkup(
      createElement(ProvidersSection, { providers: [claude, router], onChange: noop }),
    );
    expect(html).toContain('data-testid="provider-anthropic"');
    expect(html).toContain('data-testid="provider-openrouter"');
    expect(html).toContain("sk-…e5f6");
    expect(html).toContain("Add a provider");
    expect(html).toContain("changes no AI task");
    expect(
      renderToStaticMarkup(createElement(ProvidersSection, { providers: [], onChange: noop })),
    ).toContain("No paid providers.");
  });
});

describe("helpers", () => {
  it("summarizes a test with its latency and tokens", () => {
    expect(testSummary({ reply: "Ready.", latencyMs: 412, usage: { input: 18, output: 3 } })).toBe(
      "“Ready.” in 412 ms · 18 in / 3 out tokens",
    );
    expect(testSummary({ reply: "Ready.", latencyMs: 9, usage: null })).toBe("“Ready.” in 9 ms");
  });

  it("marks a saved model the chat filter dropped as 'not a chat model', and any other missing one as 'not on this server'", () => {
    expect(modelMark("nomic-embed-text", ["qwen2.5:0.5b"])).toBe("not a chat model");
    expect(modelMark("gone", ["qwen2.5:0.5b"])).toBe("not on this server");
    expect(modelMark("qwen2.5:0.5b", ["qwen2.5:0.5b"])).toBeNull();
    expect(modelMark("nomic-embed-text", null)).toBeNull();
    expect(modelMark("", ["a"])).toBeNull();
  });
});
