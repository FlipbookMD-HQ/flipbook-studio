import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ProviderView, SettingsView } from "../src/shared/api.js";
import { encodeTaskModel } from "../src/shared/taskModels.js";
import { SendsTo, taskTarget } from "../src/ui/ai.js";
import { ErrorNotice } from "../src/ui/screens/Shell.js";
import { TaskModelPicker, taskModelProblem } from "../src/ui/screens/TaskModelPicker.js";

// US-24 · 1.2.1: component tests for the grouped task pickers and the "Sends to" notice,
// rendered to static markup.
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
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyHint: "sk-…e5f6",
};
const CLAUDE = { provider: "anthropic", model: "claude-sonnet-4-5" };
const MODELS = { anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"], openrouter: ["meta/llama-3"] };
const noop = () => {};

const picker = (value: string, extra: Partial<Parameters<typeof TaskModelPicker>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(TaskModelPicker, {
      task: "generate",
      value,
      defaultModel: "small",
      localModels: ["small", "big"],
      providers: [claude, router],
      providerModels: MODELS,
      onChange: noop,
      ...extra,
    }),
  );
const optgroups = (html: string) => [...html.matchAll(/<optgroup label="([^"]*)"/g)].map((match) => match[1]);
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("TaskModelPicker", () => {
  it("groups models by provider, Local first, after Same as default (the local default)", () => {
    const html = picker("");
    expect(html.indexOf("Same as default (small)")).toBeLessThan(html.indexOf("<optgroup"));
    expect(html).toMatch(/<option value="" selected="">Same as default \(small\)<\/option>/);
    expect(optgroups(html)).toEqual(["Local", "Anthropic", "OpenRouter"]);
    expect(html).toContain('<option value="big">big</option>');
    expect(decode(html)).toContain(`<option value="${encodeTaskModel(CLAUDE)}">claude-sonnet-4-5</option>`);
    expect(html).toContain(">meta/llama-3<");
    expect(html).not.toContain("task-sends-generate");
    expect(html).not.toContain("task-model-missing");
  });

  it("says where a paid task's content goes; local tasks show no notice", () => {
    const html = decode(picker(encodeTaskModel(CLAUDE)));
    expect(html).toContain(
      `<option value="${encodeTaskModel(CLAUDE)}" selected="">claude-sonnet-4-5</option>`,
    );
    expect(html).toContain('data-testid="task-sends-generate"');
    expect(html).toContain("Sends this task&#x27;s content to Anthropic.");
    expect(picker("big")).not.toContain("task-sends");
  });

  it("marks a removed provider's model and keeps it selectable", () => {
    const html = decode(picker(encodeTaskModel(CLAUDE), { providers: [router] }));
    expect(optgroups(html)).toEqual(["Local", "OpenRouter", "anthropic (removed)"]);
    expect(html).toContain("claude-sonnet-4-5 (provider removed)");
    expect(html).toContain('data-testid="task-model-missing-generate"');
    expect(html).toContain("claude-sonnet-4-5 is from anthropic, which was removed. Pick another model.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain("task-sends-generate");
  });

  it("marks missing and not-chat models, local or paid", () => {
    expect(picker("gone")).toContain("gone (not on this server)");
    expect(picker("nomic-embed-text")).toContain("nomic-embed-text is not a chat model");
    const missing = decode(picker(encodeTaskModel({ provider: "anthropic", model: "claude-2" })));
    expect(missing).toContain("claude-2 (not offered by Anthropic)");
    expect(missing).toContain("Anthropic doesn&#x27;t offer claude-2 any more.");
    expect(picker(encodeTaskModel({ provider: "openrouter", model: "x/text-embedding" }))).toContain(
      "x/text-embedding is not a chat model",
    );
    // Lists not loaded yet mark nothing.
    expect(picker("gone", { localModels: null })).not.toContain("task-model-missing");
    expect(
      picker(encodeTaskModel({ provider: "anthropic", model: "claude-2" }), { providerModels: {} }),
    ).not.toContain("task-model-missing");
  });

  it("taskModelProblem returns null for a listed model", () => {
    expect(taskModelProblem(encodeTaskModel(CLAUDE), null, [claude], MODELS)).toBeNull();
    expect(taskModelProblem("", ["small"], [claude], MODELS)).toBeNull();
  });
});

describe("SendsTo", () => {
  it("names a paid provider and nothing for Local", () => {
    const html = renderToStaticMarkup(
      createElement(SendsTo, { provider: { id: "anthropic", label: "Anthropic", kind: "anthropic" } }),
    );
    expect(html).toContain('data-testid="sends-to"');
    expect(html).toContain("Sends to Anthropic");
    expect(
      renderToStaticMarkup(
        createElement(SendsTo, { provider: { id: "local", label: "Local", kind: "local" } }),
      ),
    ).toBe("");
    expect(renderToStaticMarkup(createElement(SendsTo, { provider: null }))).toBe("");
  });
});

describe("taskTarget", () => {
  const view = (extra: Partial<SettingsView>): SettingsView => ({
    version: 1,
    lastWorkspace: null,
    llm: {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "small",
      apiKey: null,
      temperature: 0.2,
      timeoutMs: 60_000,
      maxRepairRounds: 1,
      taskModels: { generate: CLAUDE, chat: "big" },
    },
    providers: [claude],
    ...extra,
  });

  it("resolves each task to its model and provider", () => {
    const settings = view({});
    expect(taskTarget(settings, "generate")).toEqual({
      model: "claude-sonnet-4-5",
      provider: { id: "anthropic", label: "Anthropic", kind: "anthropic" },
      removed: null,
    });
    expect(taskTarget(settings, "chat")).toEqual({
      model: "big",
      provider: { id: "local", label: "Local", kind: "local" },
      removed: null,
    });
    expect(taskTarget(settings, "rewrite")?.model).toBe("small");
  });

  it("flags a removed provider, and runs paid tasks without a local model", () => {
    expect(taskTarget(view({ providers: undefined }), "generate")).toEqual({
      model: "claude-sonnet-4-5",
      provider: null,
      removed: "anthropic",
    });
    const disconnected = view({ llm: null, paidTaskModels: { generate: CLAUDE } });
    expect(taskTarget(disconnected, "generate")?.provider?.id).toBe("anthropic");
    expect(taskTarget(disconnected, "rewrite")).toBeNull();
  });
});

describe("ErrorNotice", () => {
  it("links a missing provider to Settings", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ErrorNotice, {
          error: {
            code: "LLM_PROVIDER_MISSING",
            message: "Generate a deck uses anthropic, which was removed. Choose a model in Settings.",
            details: { task: "generate", provider: "anthropic" },
          },
        }),
      ),
    );
    expect(html).toContain("Generate a deck uses anthropic, which was removed.");
    expect(html).toMatch(/<a [^>]*href="\/settings#routing"[^>]*>Choose a model in Settings<\/a>/);
    const other = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ErrorNotice, { error: { code: "LLM_UNAUTHORIZED", message: "Rejected." } }),
      ),
    );
    expect(other).not.toContain("choose-model-link");
  });
});
