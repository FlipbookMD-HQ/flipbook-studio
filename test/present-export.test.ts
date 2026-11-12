import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkExportDependencies } from "@flipbook-md/core";
import type { ExportServices } from "../src/server/exports.js";
import { encodeDeckId } from "../src/server/paths.js";
import { headers, makeApp, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const talkFixture = path.resolve(here, "../fixtures/ws/blueprint-talk");
const talk = encodeDeckId("talk");
const LONG = `# Ask\n\n${"Name the owner, the option, and the date. ".repeat(8)}\n`;

let home: string | undefined;
const apps: { shutdown: () => Promise<void> }[] = [];
beforeEach(async () => {
  home = process.env.FLIPBOOK_HOME;
  process.env.FLIPBOOK_HOME = await tempDir("studio-home-");
});
afterEach(async () => {
  process.env.FLIPBOOK_HOME = home;
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
});

/** A fake exporter: one progress event per slide, `delay` ms apart; honours the abort signal. */
function fakeServices(overrides: Partial<ExportServices> = {}, delay = 5): ExportServices {
  const run = async (
    presentation: { slides: unknown[] },
    { onProgress, signal }: { onProgress: (p: { done: number; total: number }) => void; signal: AbortSignal },
  ) => {
    const files: string[] = [];
    for (let index = 0; index < presentation.slides.length; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal.aborted) return { cancelled: true, files };
      files.push(`${index + 1}.png`);
      onProgress({ done: index + 1, total: presentation.slides.length });
    }
    return { files: [...files, "README.txt"] };
  };
  return {
    checkDependencies: async () => ({ ok: true, missing: [], installCommand: null }),
    carousel: run as ExportServices["carousel"],
    video: run as ExportServices["video"],
    ...overrides,
  };
}

async function setup(services?: ExportServices, files: Record<string, string> = {}) {
  const root = await tempDir();
  await fs.cp(talkFixture, path.join(root, "talk"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, "talk", name), text);
  const app = await makeApp(root, [], services ? { exportServices: services } : {});
  apps.push(app);
  return { root, app };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

const post = (app: App, url: string, body: unknown) =>
  app.request(url, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

/** Reads a job's SSE stream to its end and returns the events. */
async function events(app: App, jobId: string) {
  const response = await app.request(`/api/jobs/${jobId}/events`, { headers: headers() });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map((block) =>
      JSON.parse(
        block
          .split("\n")
          .find((line) => line.startsWith("data:"))!
          .slice(5),
      ),
    );
}

describe("POST /api/decks/:id/present", () => {
  it("starts one player server per deck, reuses it, and serves saved edits", async () => {
    const { root, app } = await setup();
    const first = await (await post(app, `/api/decks/${talk}/present`, { slideIndex: 2 })).json();
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?slide=3$/);
    expect(first.announcerUrl).toBe(`${new URL(first.url).origin}/announcer`);
    const second = await (await post(app, `/api/decks/${talk}/present`, {})).json();
    expect(new URL(second.url).origin).toBe(new URL(first.url).origin);
    expect(second.url.endsWith("?slide=1")).toBe(true);
    expect(app.players.size).toBe(1);

    const origin = new URL(first.url).origin;
    expect((await (await fetch(`${origin}/api/presentation`)).json()).slides[1].title).toBe(
      "Name the decision",
    );
    await fs.writeFile(path.join(root, "talk/slides/02_point.slide.md"), "# Renamed point\n\nText.\n");
    expect((await (await fetch(`${origin}/api/presentation`)).json()).slides[1].title).toBe("Renamed point");
    expect((await fetch(`${origin}/announcer`)).status).toBe(200);
  });

  it("refuses a deck that breaks its blueprint with BLUEPRINT_FAILED", async () => {
    const { app } = await setup(undefined, { "slides/05_conclusion.slide.md": LONG });
    const response = await post(app, `/api/decks/${talk}/present`, {});
    expect(response.status).toBe(422);
    const { error } = await response.json();
    expect(error.code).toBe("BLUEPRINT_FAILED");
    expect(error.details.violations[0]).toMatchObject({
      code: "MAX_CHARS",
      source: "slides/05_conclusion.slide.md",
    });
    expect(app.players.size).toBe(0);
  });

  it("closes player servers when Studio stops", async () => {
    const { app } = await setup();
    const { url } = await (await post(app, `/api/decks/${talk}/present`, {})).json();
    await app.shutdown();
    expect(app.players.size).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("export jobs", () => {
  it("starts a job (202) and streams progress then done, in order", async () => {
    const { app } = await setup(fakeServices());
    const response = await post(app, `/api/decks/${talk}/exports`, { preset: "instagram", format: "png" });
    expect(response.status).toBe(202);
    const { jobId } = await response.json();
    const stream = await events(app, jobId);
    expect(stream.map((event) => event.type)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "done",
    ]);
    expect(stream.filter((event) => event.type === "progress").map((event) => event.done)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(stream.at(-1)).toEqual({
      type: "done",
      outputDir: "exports/talk/instagram-png",
      files: ["1.png", "2.png", "3.png", "4.png", "5.png", "README.txt"],
    });
    // Reconnecting after the end replays the final state.
    expect(await events(app, jobId)).toEqual([{ type: "progress", done: 5, total: 5 }, stream.at(-1)]);
    const info = await (await app.request(`/api/decks/${talk}/exports`, { headers: headers() })).json();
    expect(info.job).toMatchObject({ id: jobId, state: "done", progress: { done: 5, total: 5 } });
  });

  it("returns 422 BLUEPRINT_FAILED with the violations before checking anything else", async () => {
    let checked = false;
    const services = fakeServices({
      checkDependencies: async () => ((checked = true), { ok: true, missing: [], installCommand: null }),
    });
    const { app } = await setup(services, { "slides/05_conclusion.slide.md": LONG });
    const response = await post(app, `/api/decks/${talk}/exports`, { preset: "instagram", format: "png" });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "BLUEPRINT_FAILED",
      details: { violations: [{ code: "MAX_CHARS" }] },
    });
    expect(checked).toBe(false);
  });

  it("returns 424 DEPENDENCY_MISSING with the install command", async () => {
    const services = fakeServices({
      checkDependencies: async (format) => ({
        ok: false,
        missing: format === "video" ? ["ffmpeg"] : ["chromium"],
        installCommand: format === "video" ? "brew install ffmpeg" : "npx playwright install chromium",
      }),
    });
    const { app } = await setup(services);
    const response = await post(app, `/api/decks/${talk}/exports`, {
      preset: "x",
      format: "video",
      duration: 10,
    });
    expect(response.status).toBe(424);
    expect((await response.json()).error).toMatchObject({
      code: "DEPENDENCY_MISSING",
      details: { missing: ["ffmpeg"], installCommand: "brew install ffmpeg" },
    });
  });

  it("returns 409 JOB_RUNNING while an export runs, and DELETE cancels it", async () => {
    const { root, app } = await setup(fakeServices({}, 60));
    const { jobId } = await (
      await post(app, `/api/decks/${talk}/exports`, { preset: "instagram", format: "png" })
    ).json();
    const again = await post(app, `/api/decks/${talk}/exports`, { preset: "x", format: "png" });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatchObject({ code: "JOB_RUNNING", details: { jobId } });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelled = await app.request(`/api/jobs/${jobId}`, { method: "DELETE", headers: headers() });
    expect(cancelled.status).toBe(200);
    const stream = await events(app, jobId);
    expect(stream.at(-1)).toMatchObject({ type: "cancelled", outputDir: "exports/talk/instagram-png" });
    expect(stream.at(-1).files.length).toBeLessThan(5);
    expect((await app.request(`/api/jobs/${jobId}`, { method: "DELETE", headers: headers() })).status).toBe(
      200,
    );
    expect((await app.request(`/api/jobs/nope`, { method: "DELETE", headers: headers() })).status).toBe(404);
    // A new export may start once the old one has stopped.
    expect((await post(app, `/api/decks/${talk}/exports`, { preset: "x", format: "png" })).status).toBe(202);
    void root;
  });

  it("closing the event stream doesn't stop the job", async () => {
    const { app } = await setup(fakeServices({}, 20));
    const { jobId } = await (
      await post(app, `/api/decks/${talk}/exports`, { preset: "instagram", format: "png" })
    ).json();
    const controller = new AbortController();
    const response = await app.request(`/api/jobs/${jobId}/events`, {
      headers: headers(),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const stream = await events(app, jobId);
    expect(stream.at(-1).type).toBe("done");
  });

  it("guards the output folder and uses configuration.yml's defaults", async () => {
    const { root, app } = await setup(fakeServices(), {
      "configuration.yml": "export:\n  output: out/carousel\n  preset: x\n",
    });
    const info = await (await app.request(`/api/decks/${talk}/exports`, { headers: headers() })).json();
    expect(info.defaults).toMatchObject({ preset: "x", format: "png", outputDir: "talk/out/carousel" });
    expect(info.presets.map((preset: { name: string }) => preset.name)).toEqual(
      expect.arrayContaining(["instagram", "x", "linkedin", "linkedin-square", "youtube", "tiktok"]),
    );
    const unknown = await post(app, `/api/decks/${talk}/exports`, { preset: "myspace", format: "png" });
    expect(unknown.status).toBe(422);
    const { jobId } = await (
      await post(app, `/api/decks/${talk}/exports`, { preset: "x", format: "png" })
    ).json();
    expect((await events(app, jobId)).at(-1).outputDir).toBe("talk/out/carousel");

    expect(
      (await post(app, `/api/decks/${talk}/exports`, { preset: "x", format: "png", outputDir: "../outside" }))
        .status,
    ).toBe(403);
    const elsewhere = await tempDir();
    await fs.symlink(elsewhere, path.join(root, "link"));
    const linked = await post(app, `/api/decks/${talk}/exports`, {
      preset: "x",
      format: "png",
      outputDir: "link/new/folder",
    });
    expect(linked.status).toBe(403);
    expect((await linked.json()).error.code).toBe("PATH_OUTSIDE_ROOT");
  });

  it("a video without a duration is refused with the CLI's message", async () => {
    const { app } = await setup(fakeServices());
    const response = await post(app, `/api/decks/${talk}/exports`, { preset: "x", format: "video" });
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toMatch(/Video export needs a duration/);
  });

  it("a failing export ends with EXPORT_FAILED naming the output folder", async () => {
    const services = fakeServices({ carousel: async () => Promise.reject(new Error("Chromium crashed.")) });
    const { app } = await setup(services);
    const { jobId } = await (
      await post(app, `/api/decks/${talk}/exports`, { preset: "instagram", format: "png" })
    ).json();
    expect((await events(app, jobId)).at(-1)).toEqual({
      type: "failed",
      error: {
        code: "EXPORT_FAILED",
        message: "Chromium crashed. Files written so far stay in exports/talk/instagram-png.",
        path: "exports/talk/instagram-png",
      },
    });
  });
});

const sibling = path.resolve(here, "../../flipbook-md/bin/flipbook.js");
const cli = process.env.FLIPBOOK_CLI ?? (existsSync(sibling) ? sibling : null);
const chromium = (await checkExportDependencies("png")).ok;

describe.skipIf(!cli || !chromium)("a real PNG export", () => {
  it("matches a CLI export of the same deck byte for byte", { timeout: 60_000 }, async () => {
    const { root, app } = await setup();
    const { jobId } = await (
      await post(app, `/api/decks/${talk}/exports`, {
        preset: "instagram",
        format: "png",
        outputDir: "studio-out",
      })
    ).json();
    const done = (await events(app, jobId)).at(-1);
    expect(done.type).toBe("done");
    await promisify(execFile)(process.execPath, [
      cli!,
      "export",
      path.join(root, "talk"),
      "--preset",
      "instagram",
      "--output",
      path.join(root, "cli-out"),
    ]);
    const studio = (await fs.readdir(path.join(root, "studio-out"))).sort();
    expect(studio).toEqual((await fs.readdir(path.join(root, "cli-out"))).sort());
    expect(studio.filter((name) => name.endsWith(".png"))).toHaveLength(5);
    for (const name of studio) {
      const [a, b] = await Promise.all([
        fs.readFile(path.join(root, "studio-out", name)),
        fs.readFile(path.join(root, "cli-out", name)),
      ]);
      expect(a.equals(b), name).toBe(true);
    }
  });
});
