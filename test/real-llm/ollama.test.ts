import { describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/server/settings.js";
import { headers, makeApp, tempDir } from "../helpers.js";

// Runs only in the nightly workflow (vitest.real-llm.config.ts), against a real Ollama.
const BASE_URL = process.env.REAL_LLM_URL ?? "http://127.0.0.1:11434/v1";
const MODEL = process.env.REAL_LLM_MODEL ?? "qwen2.5:0.5b";

async function post(url: string, body: unknown) {
  const app = await makeApp(await tempDir(), [], {
    settings: await SettingsStore.open(await tempDir(), () => {}),
  });
  return app.request(url, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

describe("@real-llm Ollama", () => {
  it("@real-llm lists the pulled model", async () => {
    const response = await post("/api/llm/models", { baseUrl: BASE_URL });
    expect(response.status).toBe(200);
    expect((await response.json()).models.map((model: { id: string }) => model.id)).toContain(MODEL);
  });

  it("@real-llm answers the connection test", async () => {
    const response = await post("/api/llm/test", { baseUrl: BASE_URL, model: MODEL, timeoutMs: 120_000 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reply.length).toBeGreaterThan(0);
    expect(body.latencyMs).toBeGreaterThan(0);
  }, 180_000);
});
