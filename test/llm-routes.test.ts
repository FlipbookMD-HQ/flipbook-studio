import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launch } from "../src/server/launcher.js";
import { SettingsStore } from "../src/server/settings.js";
import { TEST_PROMPT } from "../src/server/llm/routes.js";
import { resetResponseFormatMemory } from "../src/server/llm/provider.js";
import { headers, makeApp, tempDir } from "./helpers.js";
import { startLlmStub, type LlmStub } from "./support/llm-stub.js";

let stub: LlmStub;
beforeEach(async () => {
  resetResponseFormatMemory();
  stub = await startLlmStub();
});
afterEach(() => stub.close());

async function app(settings?: SettingsStore) {
  return makeApp(await tempDir(), [], {
    settings: settings ?? (await SettingsStore.open(await tempDir(), () => {})),
  });
}
const post = (instance: Awaited<ReturnType<typeof app>>, url: string, body: unknown) =>
  instance.request(url, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

describe("LLM routes", () => {
  it("lists models for an unsaved base URL, including an empty list", async () => {
    const instance = await app();
    stub.setScript({ models: ["qwen2.5:0.5b", "llama3.2:1b"] });
    const response = await post(instance, "/api/llm/models", { baseUrl: stub.url.replace(/\/v1$/, "") });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [{ id: "qwen2.5:0.5b" }, { id: "llama3.2:1b" }] });
    stub.setScript({ models: [] });
    expect(await (await post(instance, "/api/llm/models", { baseUrl: stub.url })).json()).toEqual({
      models: [],
    });
  });

  it("tests a connection: the reply and its latency, with the fixed prompt", async () => {
    const instance = await app();
    stub.setScript({ chat: [{ kind: "text", text: "Ready." }] });
    const response = await post(instance, "/api/llm/test", { baseUrl: stub.url, model: "qwen2.5:0.5b" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reply).toBe("Ready.");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stub.requests.at(-1)!.body).toMatchObject({
      model: "qwen2.5:0.5b",
      messages: [{ role: "user", content: TEST_PROMPT }],
    });
  });

  it("maps each upstream failure to its code and names the base URL", async () => {
    const instance = await app();
    const cases = [
      [{ models: { kind: "status", status: 401 } }, "/api/llm/models", 502, "LLM_UNAUTHORIZED"],
      [{ chat: [{ kind: "status", status: 404 }] }, "/api/llm/test", 502, "LLM_MODEL_NOT_FOUND"],
      [{ chat: [{ kind: "status", status: 500 }] }, "/api/llm/test", 502, "LLM_UNREACHABLE"],
      [{ chat: [{ kind: "hang" }] }, "/api/llm/test", 504, "LLM_TIMEOUT"],
    ] as const;
    for (const [script, url, status, code] of cases) {
      stub.setScript(script as never);
      const response = await post(instance, url, { baseUrl: stub.url, model: "gone", timeoutMs: 5000 });
      expect(response.status, code).toBe(status);
      const { error } = await response.json();
      expect(error.code).toBe(code);
      expect(error.message).toContain(stub.url);
    }
    const dead = await startLlmStub();
    await dead.close();
    const refused = await post(instance, "/api/llm/models", { baseUrl: dead.url });
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toMatchObject({
      code: "LLM_UNREACHABLE",
      message: `Can't reach ${dead.url} — is Ollama running?`,
    });
  }, 20_000);

  it("uses the saved key when the request leaves it out, none with null, and never logs it", async () => {
    const dir = await tempDir();
    const settings = await SettingsStore.open(dir, () => {});
    await settings.update({ llm: { baseUrl: stub.url, apiKey: "sk-saved" } });
    const logs: string[] = [];
    const instance = await makeApp(await tempDir(), logs, { settings });
    stub.setScript({ apiKey: "sk-saved" });
    expect((await post(instance, "/api/llm/models", { baseUrl: stub.url })).status).toBe(200);
    expect((await post(instance, "/api/llm/models", { baseUrl: stub.url, apiKey: null })).status).toBe(502);
    expect(logs.join("\n")).not.toContain("sk-saved");
  });

  it("422 on a bad URL", async () => {
    const response = await post(await app(), "/api/llm/models", { baseUrl: "file:///etc" });
    expect(response.status).toBe(422);
  });
});

describe("launcher banner", () => {
  it("shows <model> @ <baseUrl> once settings are saved, and 'not configured' before", async () => {
    const dir = process.env.FLIPBOOK_STUDIO_CONFIG_DIR!;
    await fs.rm(path.join(dir, "settings.json"), { force: true });
    const uiDir = await tempDir("studio-ui-");
    await fs.writeFile(path.join(uiDir, "index.html"), "<div id=root></div>");
    const run = async () => {
      const logs: string[] = [];
      const launched = await launch(
        { workspace: await tempDir(), port: 0, open: false, library: await tempDir("studio-lib-") },
        { log: (line) => logs.push(line), uiDir },
      );
      await launched.close();
      return logs.join("\n");
    };
    expect(await run()).toMatch(/LLM: +not configured/);
    await (
      await SettingsStore.open(dir, () => {})
    ).update({ llm: { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:0.5b" } });
    expect(await run()).toMatch(/LLM: +qwen2\.5:0\.5b @ http:\/\/127\.0\.0\.1:11434\/v1/);
  });
});
