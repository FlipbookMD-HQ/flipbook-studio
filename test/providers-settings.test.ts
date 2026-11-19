import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiKeyHint } from "../src/server/llm/keys.js";
import { defaultProviderLabel, providerId } from "../src/server/providers.js";
import { SettingsStore, maskSettings } from "../src/server/settings.js";
import { headers, makeApp, tempDir } from "./helpers.js";

// US-21 · 1.1.1: providers[] in settings version 1 (D32) and POST/PATCH/DELETE /api/providers (D34).
const posix = process.platform !== "win32";
const quiet = () => {};
const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijklmnopa1b2";
const OPENAI_KEY = "sk-proj-0123456789abcdefc3d4";

let dir: string;
let logs: string[];
beforeEach(async () => {
  dir = await tempDir();
  logs = [];
});

async function app() {
  return makeApp(await tempDir(), logs, { settings: await SettingsStore.open(dir, quiet) });
}
type App = Awaited<ReturnType<typeof app>>;
const send = (instance: App, method: string, url: string, body?: unknown) =>
  instance.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const file = async () => JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));

describe("key hints", () => {
  it("shows the first 3 and last 4 characters, and only the mask for a short key", () => {
    expect(apiKeyHint(ANTHROPIC_KEY)).toBe("sk-…a1b2");
    expect(apiKeyHint("sk-short")).toBe("••••");
  });
});

describe("provider IDs and labels", () => {
  it("slugs the label, avoids taken and reserved IDs, and stays within 40 characters", () => {
    expect(providerId("Anthropic", [])).toBe("anthropic");
    expect(providerId("OpenRouter (work)", [])).toBe("openrouter-work");
    expect(providerId("openrouter", ["openrouter", "openrouter-2"])).toBe("openrouter-3");
    expect(providerId("Local", [])).toBe("local-2");
    expect(providerId("✨✨", [])).toBe("provider");
    const long = providerId("x".repeat(40), ["x".repeat(40)]);
    expect(long).toBe(`${"x".repeat(38)}-2`);
    for (const id of ["anthropic", "openrouter-work", long]) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it("names a provider after its kind, or its service's host", () => {
    expect(defaultProviderLabel("anthropic", "https://api.anthropic.com/v1")).toBe("Anthropic");
    expect(defaultProviderLabel("openai", "https://api.openai.com/v1")).toBe("OpenAI");
    expect(defaultProviderLabel("openai-compatible", "https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(defaultProviderLabel("openai-compatible", "https://api.together.xyz/v1")).toBe("together");
    expect(defaultProviderLabel("openai-compatible", "http://127.0.0.1:8080/v1")).toBe("127.0.0.1");
  });
});

describe("providers in settings", () => {
  it("adds, renames, replaces a key and removes a provider; the file keeps 0600 and never leaves the key", async () => {
    const instance = await app();
    const added = await send(instance, "POST", "/api/providers", {
      kind: "anthropic",
      apiKey: ` ${ANTHROPIC_KEY} `,
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyHint: "sk-…a1b2",
    });
    // Spaces around a pasted key are trimmed.
    expect((await file()).providers[0].apiKey).toBe(ANTHROPIC_KEY);
    if (posix) {
      expect((await fs.stat(path.join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }

    const renamed = await send(instance, "PATCH", "/api/providers/anthropic", { label: "Claude" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: "anthropic", label: "Claude", apiKeyHint: "sk-…a1b2" });

    const rekeyed = await send(instance, "PATCH", "/api/providers/anthropic", {
      apiKey: "sk-ant-api03-zzzzzzzzzzzzzzzzz9z9",
    });
    expect(await rekeyed.json()).toMatchObject({ id: "anthropic", label: "Claude", apiKeyHint: "sk-…z9z9" });
    expect((await file()).providers[0]).toMatchObject({
      id: "anthropic",
      apiKey: "sk-ant-api03-zzzzzzzzzzzzzzzzz9z9",
    });

    const settings = await (await send(instance, "GET", "/api/settings")).json();
    expect(settings.providers).toEqual([
      {
        id: "anthropic",
        kind: "anthropic",
        label: "Claude",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyHint: "sk-…z9z9",
      },
    ]);
    expect(JSON.stringify(settings)).not.toContain("sk-ant-api03");

    expect((await send(instance, "DELETE", "/api/providers/anthropic")).status).toBe(204);
    expect(await file()).toEqual({ version: 1, llm: null, lastWorkspace: null });
    expect((await send(instance, "DELETE", "/api/providers/anthropic")).status).toBe(404);
    expect(logs.join("\n")).not.toContain("sk-ant-api03");
    if (posix) expect((await fs.stat(path.join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
  });

  it("allows one anthropic and one openai provider, and any number of openai-compatible ones", async () => {
    const instance = await app();
    expect(
      (await send(instance, "POST", "/api/providers", { kind: "anthropic", apiKey: ANTHROPIC_KEY })).status,
    ).toBe(201);
    expect(
      (await send(instance, "POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY })).status,
    ).toBe(201);
    for (const kind of ["anthropic", "openai"]) {
      const again = await send(instance, "POST", "/api/providers", { kind, apiKey: "sk-another-key-0000" });
      expect(again.status).toBe(409);
      expect((await again.json()).error).toMatchObject({
        code: "PROVIDER_EXISTS",
        details: { providerId: kind },
      });
    }
    const ids: string[] = [];
    for (const label of [undefined, undefined, "OpenRouter"]) {
      const response = await send(instance, "POST", "/api/providers", {
        kind: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-v1-0000000000000000e5f6",
        ...(label ? { label } : {}),
      });
      expect(response.status).toBe(201);
      ids.push((await response.json()).id);
    }
    expect(ids).toEqual(["openrouter", "openrouter-2", "openrouter-3"]);
    expect((await file()).providers.map((p: { id: string }) => p.id)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "openrouter-2",
      "openrouter-3",
    ]);
  });

  it("refuses plain http to a host that isn't loopback, and a base URL where it's fixed or missing", async () => {
    const instance = await app();
    const bad = [
      { kind: "openai-compatible", baseUrl: "http://example.com/v1", apiKey: "sk-123456789012" },
      { kind: "openai-compatible", baseUrl: "http://192.168.1.20:8080/v1", apiKey: "sk-123456789012" },
      { kind: "openai-compatible", baseUrl: "ftp://example.com", apiKey: "sk-123456789012" },
      { kind: "openai-compatible", apiKey: "sk-123456789012" },
      { kind: "anthropic", baseUrl: "https://evil.example/v1", apiKey: "sk-123456789012" },
      { kind: "anthropic", apiKey: "   " },
      { kind: "anthropic", apiKey: "x".repeat(501) },
      { kind: "anthropic", apiKey: "sk-123456789012", label: "x".repeat(41) },
      { kind: "mistral", apiKey: "sk-123456789012" },
      { kind: "anthropic", apiKey: "sk-123456789012", extra: true },
    ];
    for (const body of bad) {
      const response = await send(instance, "POST", "/api/providers", body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
    for (const baseUrl of ["http://127.0.0.1:8080/v1", "http://localhost:1234/v1", "http://[::1]:9000/v1"]) {
      const response = await send(instance, "POST", "/api/providers", {
        kind: "openai-compatible",
        baseUrl,
        apiKey: "sk-123456789012",
      });
      expect(response.status, baseUrl).toBe(201);
    }
    // PATCH: the same rules, a fixed URL can't move, and an unknown ID is 404.
    const local = (await file()).providers[0].id;
    expect(
      (await send(instance, "PATCH", `/api/providers/${local}`, { baseUrl: "http://example.com/v1" })).status,
    ).toBe(422);
    expect(
      (await send(instance, "PATCH", `/api/providers/${local}`, { baseUrl: "https://example.com/v1" }))
        .status,
    ).toBe(200);
    await send(instance, "POST", "/api/providers", { kind: "openai", apiKey: OPENAI_KEY });
    expect(
      (await send(instance, "PATCH", "/api/providers/openai", { baseUrl: "https://example.com/v1" })).status,
    ).toBe(422);
    const missing = await send(instance, "PATCH", "/api/providers/nope", { label: "x" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROVIDER_NOT_FOUND");
    expect(JSON.stringify(await (await send(instance, "GET", "/api/settings")).json())).not.toContain(
      OPENAI_KEY,
    );
  });

  it("loads a Release 2 settings.json unchanged, and adding or removing a provider leaves the LLM and task models alone", async () => {
    const release2 = {
      version: 1,
      llm: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:0.5b",
        apiKey: null,
        temperature: 0.2,
        timeoutMs: 60000,
        maxRepairRounds: 1,
        taskModels: { generate: "llama3.2:1b", chat: "qwen2.5:7b" },
      },
      lastWorkspace: "/decks",
    };
    await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(release2), { mode: 0o600 });
    const store = await SettingsStore.open(dir, quiet);
    expect(store.current()).toEqual(release2);
    expect(maskSettings(store.current())).toEqual(release2);
    expect(await fs.readFile(path.join(dir, "settings.json.bak"), "utf8").catch(() => null)).toBeNull();

    const instance = await makeApp(await tempDir(), logs, { settings: store });
    await send(instance, "POST", "/api/providers", { kind: "anthropic", apiKey: ANTHROPIC_KEY });
    expect((await file()).llm).toEqual(release2.llm);
    expect((await (await send(instance, "GET", "/api/settings")).json()).llm.taskModels).toEqual(
      release2.llm.taskModels,
    );
    // A PUT /api/settings keeps the providers, and llm: null clears only the local connection.
    await send(instance, "PUT", "/api/settings", { llm: { temperature: 0.5 } });
    expect((await file()).providers).toHaveLength(1);
    await send(instance, "PUT", "/api/settings", { llm: null });
    expect((await file()).providers).toHaveLength(1);
    await send(instance, "DELETE", "/api/providers/anthropic");
    expect(await file()).toEqual({ version: 1, llm: null, lastWorkspace: "/decks" });
  });

  it("refuses provider changes when the settings file has an unknown version", async () => {
    const future = JSON.stringify({ version: 2 });
    await fs.writeFile(path.join(dir, "settings.json"), future);
    const instance = await app();
    const response = await send(instance, "POST", "/api/providers", {
      kind: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SETTINGS_UNSUPPORTED");
    expect(await fs.readFile(path.join(dir, "settings.json"), "utf8")).toBe(future);
  });
});

describe("fixed base URLs", () => {
  const saved = process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL;
    else process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL = saved;
  });

  it("can point a fixed-URL kind at a fake server for tests", async () => {
    process.env.FLIPBOOK_STUDIO_ANTHROPIC_URL = "http://127.0.0.1:9/v1";
    const instance = await app();
    const response = await send(instance, "POST", "/api/providers", {
      kind: "anthropic",
      apiKey: ANTHROPIC_KEY,
    });
    expect((await response.json()).baseUrl).toBe("http://127.0.0.1:9/v1");
  });
});
