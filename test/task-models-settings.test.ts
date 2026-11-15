import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/server/settings.js";
import { headers, makeApp, tempDir } from "./helpers.js";

// US-19 · 1.1.1: llm.taskModels in settings (tech-spec D29).

const quiet = () => {};
async function setup() {
  const dir = path.join(await tempDir(), "flipbook-studio");
  const open = async () => makeApp(await tempDir(), [], { settings: await SettingsStore.open(dir, quiet) });
  const app = await open();
  const put = async (instance: typeof app, body: unknown) =>
    instance.request("/api/settings", {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const get = async (instance: typeof app) =>
    (await instance.request("/api/settings", { headers: headers() })).json();
  await put(app, { llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "small", apiKey: "secret" } });
  return { dir, app, open, put, get };
}

describe("task models in settings", () => {
  it("sets, keeps and clears each task's model, and stores an empty map as none", async () => {
    const { app, put, get } = await setup();
    expect((await get(app)).llm.taskModels).toBeUndefined();

    expect((await put(app, { llm: { taskModels: { chat: "big", generate: "big" } } })).status).toBe(200);
    expect((await get(app)).llm).toMatchObject({
      model: "small",
      taskModels: { chat: "big", generate: "big" },
    });

    await put(app, { llm: { taskModels: { rewrite: "tiny" } } });
    expect((await get(app)).llm.taskModels).toEqual({ chat: "big", generate: "big", rewrite: "tiny" });

    await put(app, { llm: { temperature: 0.7 } });
    expect((await get(app)).llm.taskModels).toEqual({ chat: "big", generate: "big", rewrite: "tiny" });

    await put(app, { llm: { taskModels: { chat: null, rewrite: null } } });
    expect((await get(app)).llm.taskModels).toEqual({ generate: "big" });

    await put(app, { llm: { taskModels: { generate: null } } });
    const llm = (await get(app)).llm;
    expect("taskModels" in llm).toBe(false);
    expect(llm.model).toBe("small");
    expect(llm.apiKey).toBe("••••");
  });

  it("removes task models with the connection", async () => {
    const { app, put, get } = await setup();
    await put(app, { llm: { taskModels: { chat: "big" } } });
    await put(app, { llm: null });
    expect((await get(app)).llm).toBeNull();
    await put(app, { llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "small" } });
    expect((await get(app)).llm.taskModels).toBeUndefined();
  });

  it("refuses unknown tasks and empty model IDs with 422", async () => {
    const { app, put, get } = await setup();
    for (const taskModels of [{ summarize: "x" }, { chat: "" }, { chat: "   " }, { chat: 3 }]) {
      const response = await put(app, { llm: { taskModels } });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
    expect((await get(app)).llm.taskModels).toBeUndefined();
  });

  it("survives a restart with mode 0600, and loads a file without task models unchanged", async () => {
    const { dir, app, open, put, get } = await setup();
    await put(app, { llm: { taskModels: { draft: "big" } } });
    const file = path.join(dir, "settings.json");
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await get(await open())).llm.taskModels).toEqual({ draft: "big" });

    const old = {
      version: 1,
      llm: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "small",
        apiKey: null,
        temperature: 0.2,
        timeoutMs: 60000,
        maxRepairRounds: 1,
      },
      lastWorkspace: null,
    };
    await fs.writeFile(file, JSON.stringify(old));
    expect(await get(await open())).toEqual(old);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(old);
  });
});
