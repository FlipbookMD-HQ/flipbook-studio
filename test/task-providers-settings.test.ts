import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { decodeTaskModel, encodeTaskModel } from "../src/shared/taskModels.js";
import { headers, makeApp, tempDir } from "./helpers.js";

// US-24 · 1.1.1: task models can name a paid provider (tech-spec D32), keeping the D29 merge rules.

const quiet = () => {};
const CLAUDE = { provider: "anthropic", model: "claude-sonnet-4-5" };

async function setup() {
  const dir = path.join(await tempDir(), "flipbook-studio");
  const open = async () => makeApp(await tempDir(), [], { settings: await SettingsStore.open(dir, quiet) });
  const app = await open();
  const send = (instance: typeof app, method: string, url: string, body?: unknown) =>
    instance.request(url, {
      method,
      headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const put = (instance: typeof app, body: unknown) => send(instance, "PUT", "/api/settings", body);
  const get = async (instance: typeof app) => (await send(instance, "GET", "/api/settings")).json();
  const file = async () => JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
  await put(app, { llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "small" } });
  expect(
    (await send(app, "POST", "/api/providers", { kind: "anthropic", apiKey: "sk-ant-api03-settings-a1b2" }))
      .status,
  ).toBe(201);
  return { dir, app, open, send, put, get, file };
}

describe("task models that name a provider", () => {
  it("saves a paid task model and keeps the other tasks", async () => {
    const { app, put, get, file } = await setup();
    await put(app, { llm: { taskModels: { chat: "big", rewrite: "tiny" } } });
    const response = await put(app, { llm: { taskModels: { generate: CLAUDE } } });
    expect(response.status).toBe(200);
    expect((await response.json()).llm.taskModels).toEqual({
      chat: "big",
      rewrite: "tiny",
      generate: CLAUDE,
    });
    expect((await get(app)).llm.taskModels).toEqual({ chat: "big", rewrite: "tiny", generate: CLAUDE });
    expect((await file()).llm.taskModels.generate).toEqual(CLAUDE);

    // A string sets the task back to a local model; null resets it to the default.
    await put(app, { llm: { taskModels: { generate: "big", chat: CLAUDE } } });
    expect((await get(app)).llm.taskModels).toEqual({ chat: CLAUDE, rewrite: "tiny", generate: "big" });
    await put(app, { llm: { taskModels: { chat: null, generate: null, rewrite: null } } });
    expect("taskModels" in (await get(app)).llm).toBe(false);
  });

  it("refuses an unknown provider with 422 and changes nothing", async () => {
    const { app, put, get } = await setup();
    await put(app, { llm: { taskModels: { chat: "big" } } });
    for (const bad of [
      { provider: "openai", model: "gpt-4o" },
      { provider: "local", model: "small" },
      { provider: "Not An ID", model: "x" },
      { provider: "anthropic" },
      { provider: "anthropic", model: "x", extra: 1 },
    ]) {
      const response = await put(app, { llm: { taskModels: { generate: bad } } });
      expect(response.status, JSON.stringify(bad)).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
    const unknown = await put(app, {
      llm: { taskModels: { generate: { provider: "openai", model: "gpt-4o" } } },
    });
    expect((await unknown.json()).error.details.fields).toEqual([
      { path: "llm.taskModels.generate.provider", message: 'There\'s no provider "openai".' },
    ]);
    expect((await get(app)).llm.taskModels).toEqual({ chat: "big" });
  });

  it("keeps the task models of a removed provider", async () => {
    const { app, send, put, get, open } = await setup();
    await put(app, { llm: { taskModels: { generate: CLAUDE, chat: "big" } } });
    expect((await send(app, "DELETE", "/api/providers/anthropic")).status).toBe(204);
    expect((await get(app)).llm.taskModels).toEqual({ generate: CLAUDE, chat: "big" });
    // Other tasks can still change; the dangling one stays until the user picks another model.
    await put(app, { llm: { taskModels: { chat: "small" } } });
    expect((await get(app)).llm.taskModels).toEqual({ generate: CLAUDE, chat: "small" });
    // …and a restart loads it.
    const restarted = await open();
    expect((await get(restarted)).llm.taskModels).toEqual({ generate: CLAUDE, chat: "small" });
  });

  it("llm: null clears only the local task models; the paid ones come back with a new connection", async () => {
    const { app, put, get, file, open } = await setup();
    await put(app, { llm: { taskModels: { generate: CLAUDE, chat: "big" } } });
    await put(app, { llm: null });
    const cleared = await get(app);
    expect(cleared.llm).toBeNull();
    expect(cleared.paidTaskModels).toEqual({ generate: CLAUDE });
    expect((await file()).paidTaskModels).toEqual({ generate: CLAUDE });
    expect((await get(await open())).paidTaskModels).toEqual({ generate: CLAUDE });

    // Disconnecting again keeps them.
    await put(app, { llm: null });
    expect((await get(app)).paidTaskModels).toEqual({ generate: CLAUDE });

    await put(app, { llm: { baseUrl: "http://127.0.0.1:1234/v1", model: "other" } });
    const back = await get(app);
    expect(back.llm.taskModels).toEqual({ generate: CLAUDE });
    expect("paidTaskModels" in back).toBe(false);
  });

  it("llm: null with only local task models leaves nothing behind", async () => {
    const { app, put, get, file } = await setup();
    await put(app, { llm: { taskModels: { chat: "big" } } });
    await put(app, { llm: null });
    expect("paidTaskModels" in (await get(app))).toBe(false);
    expect("paidTaskModels" in (await file())).toBe(false);
  });

  it("loads a Release 2 settings.json unchanged, every task on local models", async () => {
    const dir = path.join(await tempDir(), "flipbook-studio");
    await fs.mkdir(dir, { recursive: true });
    const release2 = {
      version: 1,
      llm: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "small",
        apiKey: null,
        temperature: 0.2,
        timeoutMs: 60_000,
        maxRepairRounds: 1,
        taskModels: { chat: "big", generate: "huge" },
      },
      lastWorkspace: "/tmp/ws",
    };
    const text = `${JSON.stringify(release2, null, 2)}\n`;
    await fs.writeFile(path.join(dir, "settings.json"), text);
    const logs: string[] = [];
    const store = await SettingsStore.open(dir, (line) => logs.push(line));
    expect(store.current()).toEqual(release2);
    expect(logs).toEqual([]);
    expect(await fs.readFile(path.join(dir, "settings.json"), "utf8")).toBe(text);
    await expect(fs.stat(path.join(dir, "settings.json.bak"))).rejects.toThrow();
  });
});

describe("task model <select> values", () => {
  it("round-trips local IDs, paid models and the default", () => {
    for (const value of [
      "llama3.2:1b",
      "small",
      CLAUDE,
      { provider: "openrouter", model: "meta/llama:free" },
    ])
      expect(decodeTaskModel(encodeTaskModel(value))).toEqual(value);
    expect(encodeTaskModel("small")).toBe("small");
    expect(encodeTaskModel(null)).toBe("");
    expect(decodeTaskModel("")).toBeNull();
  });
});
