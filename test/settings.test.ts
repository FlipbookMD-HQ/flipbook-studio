import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, configDir } from "../src/server/settings.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const posix = process.platform !== "win32";
const quiet = () => {};

async function app(dir: string) {
  const root = await tempDir();
  return makeApp(root, [], { settings: await SettingsStore.open(dir, quiet) });
}
const send = (instance: Awaited<ReturnType<typeof app>>, method: string, url: string, body?: unknown) =>
  instance.request(url, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("config folder", () => {
  it("follows the OS conventions and the test override", () => {
    expect(configDir({ FLIPBOOK_STUDIO_CONFIG_DIR: "/tmp/x" }, "linux")).toBe("/tmp/x");
    expect(configDir({}, "darwin")).toMatch(/Library\/Application Support\/flipbook-studio$/);
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/flipbook-studio");
    expect(configDir({}, "linux")).toMatch(/\.config\/flipbook-studio$/);
  });
});

describe("settings store and routes", () => {
  it("starts with defaults, saves, masks the key and survives a restart with mode 0600", async () => {
    const dir = path.join(await tempDir(), "flipbook-studio");
    const first = await app(dir);
    expect(await (await send(first, "GET", "/api/settings")).json()).toEqual({
      version: 1,
      llm: null,
      lastWorkspace: null,
    });

    const saved = await send(first, "PUT", "/api/settings", {
      llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:0.5b", apiKey: "sk-secret" },
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.llm).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:0.5b",
      apiKey: "••••",
      temperature: 0.2,
      timeoutMs: 60000,
      maxRepairRounds: 1,
    });
    expect(JSON.stringify(body)).not.toContain("sk-secret");

    const file = path.join(dir, "settings.json");
    expect(JSON.parse(await fs.readFile(file, "utf8")).llm.apiKey).toBe("sk-secret");
    if (posix) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }

    // A restart reads the same settings.
    const second = await app(dir);
    expect((await (await send(second, "GET", "/api/settings")).json()).llm.model).toBe("qwen2.5:0.5b");
  });

  it("keeps the key when it's left out or masked, clears it with null, and removes the LLM with llm: null", async () => {
    const dir = await tempDir();
    const instance = await app(dir);
    const read = async () => JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
    await send(instance, "PUT", "/api/settings", { llm: { baseUrl: "http://localhost:1234", apiKey: "k1" } });
    await send(instance, "PUT", "/api/settings", { llm: { temperature: 1.5 } });
    await send(instance, "PUT", "/api/settings", { llm: { apiKey: "••••", model: "m" } });
    expect((await read()).llm).toMatchObject({ apiKey: "k1", temperature: 1.5, model: "m" });
    await send(instance, "PUT", "/api/settings", { llm: { apiKey: null } });
    expect((await read()).llm.apiKey).toBeNull();
    expect((await (await send(instance, "GET", "/api/settings")).json()).llm.apiKey).toBeNull();
    await send(instance, "PUT", "/api/settings", { llm: null, lastWorkspace: "/w" });
    expect(await read()).toEqual({ version: 1, llm: null, lastWorkspace: "/w" });
  });

  it("refuses bad values with 422", async () => {
    const instance = await app(await tempDir());
    const bad = [
      { llm: { baseUrl: "ftp://example.com" } },
      { llm: { baseUrl: "not a url" } },
      { llm: { model: "m" } }, // No base URL yet.
      { llm: { baseUrl: "http://x", temperature: 3 } },
      { llm: { baseUrl: "http://x", timeoutMs: 1000 } },
      { llm: { baseUrl: "http://x", maxRepairRounds: 4 } },
      { llm: { baseUrl: "http://x", extra: 1 } },
    ];
    for (const body of bad) {
      const response = await send(instance, "PUT", "/api/settings", body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("backs up a corrupt file and starts with defaults", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "settings.json"), "{ not json");
    const warnings: string[] = [];
    const store = await SettingsStore.open(dir, (line) => warnings.push(line));
    expect(store.current()).toEqual({ version: 1, llm: null, lastWorkspace: null });
    expect(await fs.readFile(path.join(dir, "settings.json.bak"), "utf8")).toBe("{ not json");
    expect(warnings[0]).toMatch(/settings\.json\.bak/);
  });

  it("refuses an unknown version and never overwrites it", async () => {
    const dir = await tempDir();
    const future = JSON.stringify({ version: 2, llm: { provider: "x" } });
    await fs.writeFile(path.join(dir, "settings.json"), future);
    const instance = makeApp(await tempDir(), [], { settings: await SettingsStore.open(dir, quiet) });
    const response = await send(await instance, "PUT", "/api/settings", { lastWorkspace: "/w" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SETTINGS_UNSUPPORTED");
    expect(await fs.readFile(path.join(dir, "settings.json"), "utf8")).toBe(future);
  });
});
