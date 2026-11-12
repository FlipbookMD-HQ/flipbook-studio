import crypto from "node:crypto";
import type { ApiError, ExportJob, JobEvent } from "../shared/api.js";

export interface JobHooks {
  onProgress: (progress: { done: number; total: number }) => void;
  signal: AbortSignal;
}

/** What a job's work resolves to: the files written, or a cancellation. */
export type JobOutcome = { outputDir: string; files: string[]; cancelled?: boolean };

interface Entry {
  job: ExportJob;
  controller: AbortController;
  listeners: Set<(event: JobEvent) => void>;
}

/**
 * Export jobs in memory (lost on restart). One running job per deck. Listeners get every event;
 * a new listener first gets the current state, so reconnecting replays it.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Entry>();

  running(deckId: string): ExportJob | null {
    for (const { job } of this.jobs.values())
      if (job.deckId === deckId && job.state === "running") return job;
    return null;
  }

  /** The deck's running job, or else its most recent one. */
  latest(deckId: string): ExportJob | null {
    let found: ExportJob | null = null;
    for (const { job } of this.jobs.values()) if (job.deckId === deckId) found = job;
    return this.running(deckId) ?? found;
  }

  get(id: string): ExportJob | null {
    return this.jobs.get(id)?.job ?? null;
  }

  start(
    meta: Pick<ExportJob, "deckId" | "preset" | "format" | "outputDir">,
    total: number,
    work: (hooks: JobHooks) => Promise<JobOutcome>,
    describe: (error: unknown) => ApiError,
  ): ExportJob {
    const job: ExportJob = {
      id: crypto.randomUUID(),
      ...meta,
      state: "running",
      progress: { done: 0, total },
      files: [],
      error: null,
    };
    const entry: Entry = { job, controller: new AbortController(), listeners: new Set() };
    this.jobs.set(job.id, entry);
    const emit = (event: JobEvent) => entry.listeners.forEach((listener) => listener(event));
    void work({
      signal: entry.controller.signal,
      onProgress: (progress) => {
        job.progress = progress;
        emit({ type: "progress", ...progress });
      },
    }).then(
      (outcome) => {
        job.outputDir = outcome.outputDir;
        job.files = outcome.files;
        job.state = outcome.cancelled ? "cancelled" : "done";
        emit(this.finalEvent(job)!);
      },
      (error: unknown) => {
        job.state = "failed";
        job.error = describe(error);
        emit(this.finalEvent(job)!);
      },
    );
    return job;
  }

  private finalEvent(job: ExportJob): JobEvent | null {
    if (job.state === "done") return { type: "done", outputDir: job.outputDir!, files: job.files };
    if (job.state === "cancelled") return { type: "cancelled", outputDir: job.outputDir!, files: job.files };
    if (job.state === "failed") return { type: "failed", error: job.error! };
    return null;
  }

  /** The events that describe a job's current state, for a listener that just connected. */
  replay(id: string): JobEvent[] {
    const job = this.get(id);
    if (!job) return [];
    const final = this.finalEvent(job);
    return [{ type: "progress", ...job.progress }, ...(final ? [final] : [])];
  }

  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    const entry = this.jobs.get(id);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  cancel(id: string): ExportJob | null {
    const entry = this.jobs.get(id);
    if (entry?.job.state === "running") entry.controller.abort();
    return entry?.job ?? null;
  }

  cancelAll(): void {
    for (const { job, controller } of this.jobs.values()) if (job.state === "running") controller.abort();
  }
}
