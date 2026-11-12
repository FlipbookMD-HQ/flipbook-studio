import path from "node:path";
import fs from "node:fs/promises";
import {
  PRESETS,
  checkExportDependencies,
  exportCarousel,
  exportVideo,
  loadConfiguration,
  resolveExportOptions,
  type Presentation,
} from "@flipbook-md/core";
import type { ApiError, ExportJob, ExportRequest, ExportsInfo } from "../shared/api.js";
import { findDeck, loadDeck } from "./decks.js";
import { StudioError } from "./errors.js";
import type { JobHooks, JobOutcome, JobRegistry } from "./jobs.js";
import { resolveOutputDir } from "./paths.js";
import type { DeckEntry } from "./workspace.js";

/** Seams for tests: the dependency check and the exporters (core's by default). */
export interface ExportServices {
  checkDependencies: typeof checkExportDependencies;
  carousel: (
    presentation: Presentation,
    options: { preset: string; outputDir: string } & JobHooks,
  ) => Promise<unknown>;
  video: (presentation: Presentation, options: Record<string, unknown> & JobHooks) => Promise<unknown>;
}

export const coreExports: ExportServices = {
  checkDependencies: checkExportDependencies,
  carousel: (presentation, options) => exportCarousel(presentation, options),
  video: (presentation, options) =>
    exportVideo(presentation, options as Parameters<typeof exportVideo>[1] & { signal: AbortSignal }),
};

const deckRoot = (deck: DeckEntry) => (deck.kind === "folder" ? deck.absolute : path.dirname(deck.absolute));
const deckName = (deck: DeckEntry) =>
  deck.relative.replace(/\.slide\.md$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");

async function workspaceRelative(root: string, target: string): Promise<string | null> {
  const relative = path.relative(await fs.realpath(root), target);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative.split(path.sep).join("/");
}

async function defaults(root: string, deck: DeckEntry): Promise<ExportsInfo["defaults"]> {
  const config = await loadConfiguration(deckRoot(deck)).catch(() => ({
    export: {} as Record<string, unknown>,
  }));
  const exp = (config.export ?? {}) as Record<string, unknown>;
  const output = typeof exp.output === "string" && exp.output.trim() ? exp.output.trim() : null;
  const preset = typeof exp.preset === "string" && exp.preset in PRESETS ? exp.preset : "instagram";
  const duration = Number(exp.duration);
  return {
    preset,
    format: exp.format === "video" ? "video" : "png",
    // configuration.yml paths are relative to the deck, as when the CLI runs there.
    outputDir: output ? await workspaceRelative(root, path.resolve(deckRoot(deck), output)) : null,
    outputBase: `exports/${deckName(deck)}`,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/** GET /api/decks/:id/exports */
export async function exportsInfo(root: string, id: string, jobs: JobRegistry): Promise<ExportsInfo> {
  const deck = await findDeck(root, id);
  return {
    job: jobs.latest(id),
    presets: Object.entries(PRESETS).map(([name, preset]) => ({
      name,
      width: preset.width,
      height: preset.height,
      use: preset.use,
    })),
    defaults: await defaults(root, deck),
  };
}

function describeFailure(outputDir: string) {
  return (error: unknown): ApiError => ({
    code: "EXPORT_FAILED",
    message: `${(error as Error)?.message ?? String(error)} Files written so far stay in ${outputDir}.`,
    path: outputDir,
  });
}

/**
 * POST /api/decks/:id/exports: checks the blueprint, then the dependencies, then that no export
 * is running for the deck, and starts a job.
 */
export async function startExport(
  root: string,
  id: string,
  request: ExportRequest,
  jobs: JobRegistry,
  services: ExportServices,
): Promise<ExportJob> {
  const deck = await findDeck(root, id);
  if (!(request.preset in PRESETS)) {
    throw new StudioError(422, "VALIDATION_FAILED", `Unknown preset "${request.preset}".`, {
      details: { field: "preset" },
    });
  }
  const { presentation, violations } = await loadDeck(deck);
  if (violations.length) {
    throw new StudioError(422, "BLUEPRINT_FAILED", "Fix the blueprint issues before exporting.", {
      details: { violations },
    });
  }
  const deps = await services.checkDependencies(request.format);
  if (!deps.ok) {
    throw new StudioError(
      424,
      "DEPENDENCY_MISSING",
      `Export needs ${deps.missing.join(" and ")}. Run: ${deps.installCommand}`,
      {
        details: { missing: deps.missing, installCommand: deps.installCommand },
      },
    );
  }
  const running = jobs.running(id);
  if (running) {
    throw new StudioError(409, "JOB_RUNNING", "An export is already running for this deck.", {
      details: { jobId: running.id },
    });
  }

  const base = await defaults(root, deck);
  const relative =
    request.outputDir ?? base.outputDir ?? `${base.outputBase}/${request.preset}-${request.format}`;
  const outputDir = await resolveOutputDir(root, relative);
  let options;
  try {
    const config = await loadConfiguration(deckRoot(deck));
    options = resolveExportOptions(config, {
      format: request.format === "png" ? "carousel" : "video",
      preset: request.preset,
      outputDir,
      ...(request.duration != null ? { duration: request.duration } : {}),
    });
  } catch (error) {
    throw new StudioError(422, "VALIDATION_FAILED", (error as Error).message);
  }

  const shown = (await workspaceRelative(root, outputDir)) ?? relative;
  const work = async (hooks: JobHooks): Promise<JobOutcome> => {
    const result = (
      request.format === "png"
        ? await services.carousel(presentation, { preset: options.preset, outputDir, ...hooks })
        : await services.video(presentation, { ...options, outputDir, ...hooks })
    ) as {
      files?: string[];
      cancelled?: boolean;
    };
    return { outputDir: shown, files: result.files ?? [], ...(result.cancelled ? { cancelled: true } : {}) };
  };
  return jobs.start(
    { deckId: id, preset: request.preset, format: request.format, outputDir: shown },
    presentation.slides.length,
    work,
    describeFailure(shown),
  );
}
