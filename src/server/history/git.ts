import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// US-23 (tech-spec D36, D43): every git call Studio makes goes through here. `git` runs through
// spawn with an argument array (no shell), a fixed environment, `-c core.fsmonitor=false`, a
// timeout and one queue per repository. Studio never changes git config, pushes or rewrites refs.

export const GIT_TIMEOUT_MS = 30_000;
export const MIN_GIT_VERSION = [2, 30] as const;
/** GitError.output keeps the end of git's output, at most this many bytes. */
export const GIT_OUTPUT_BYTES = 4 * 1024;

export type GitErrorKind = "not_installed" | "not_repo" | "busy" | "failed" | "timeout";

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
    /** The last 4 kB of git's stdout and stderr. */
    readonly output = "",
    /** The exit code, when git ran and exited. */
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  cwd: string;
  /** Default 30 s. */
  timeoutMs?: number;
  /** Written to git's stdin (a commit note goes here, never into an argument). */
  input?: Buffer | string;
  /** A read-only command: sets GIT_OPTIONAL_LOCKS=0 so it never takes the index lock. */
  read?: boolean;
  /** Exit codes that aren't failures (`check-ignore` exits 1 for "not ignored"). Default [0]. */
  okCodes?: number[];
  /** Extra `-c key=value` settings for this command only (the author from Studio settings). */
  config?: Record<string, string>;
  /** The queue this command waits in; defaults to `cwd`. Pass the repo root once it's known. */
  repo?: string;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export type GitAvailability = { ok: true; version: string } | { ok: false; reason: string };

/** Variables that would point git at another repository than the one Studio asks about. */
const REPO_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_EXTERNAL_DIFF",
];

const tail = (text: string) =>
  Buffer.byteLength(text) <= GIT_OUTPUT_BYTES
    ? text
    : Buffer.from(text).subarray(-GIT_OUTPUT_BYTES).toString("utf8").replace(/^�+/, "");

/** "git version 2.39.3 (Apple Git-145)" → [2, 39]; null when it doesn't parse. */
export function parseGitVersion(text: string): [number, number] | null {
  const match = /git version (\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Why git's stderr means the repository is busy (a lock or an operation in progress), or null. */
export function busyReason(stderr: string): string | null {
  if (/index\.lock'?: File exists|Unable to create '[^']*\.lock'/i.test(stderr)) return "index.lock exists";
  if (/You have not concluded your merge|in the middle of a merge|merging is not possible/i.test(stderr))
    return "a merge is in progress";
  if (/cherry-pick is (already )?in progress|in the middle of a cherry-pick/i.test(stderr))
    return "a cherry-pick is in progress";
  if (/rebase(-merge| -i)? .*in progress|in the middle of (a|an interactive) rebase/i.test(stderr))
    return "a rebase is in progress";
  return null;
}

export class GitRunner {
  private queues = new Map<string, Promise<unknown>>();
  private availability: Promise<GitAvailability> | null = null;

  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  /**
   * @param options.env the environment git starts from (default: Studio's own). Tests pass a
   *   PATH with a fake `git`, or a HOME without global config.
   * @param options.timeoutMs the per-command timeout (default 30 s).
   */
  constructor(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    this.baseEnv = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  /** Checks once that git is installed and at least 2.30; later calls reuse the answer. */
  check(): Promise<GitAvailability> {
    this.availability ??= this.spawnGit(["--version"], {
      cwd: process.cwd(),
      read: true,
      timeoutMs: GIT_TIMEOUT_MS,
    }).then(
      ({ stdout }) => {
        const text = stdout.toString("utf8").trim();
        const version = parseGitVersion(text);
        if (!version) return { ok: false, reason: `Studio can't read git's version ("${text}").` };
        const [major, minor] = version;
        const [needMajor, needMinor] = MIN_GIT_VERSION;
        if (major < needMajor || (major === needMajor && minor < needMinor))
          return {
            ok: false,
            reason: `History needs git ${needMajor}.${needMinor} or newer; this computer has ${major}.${minor}.`,
          };
        return { ok: true, version: `${major}.${minor}` };
      },
      (error: unknown) => ({
        ok: false,
        reason:
          error instanceof GitError && error.kind === "not_installed"
            ? "Git isn't installed (no git command on PATH). Install git 2.30 or newer to save versions."
            : `Git doesn't run: ${(error as Error).message}`,
      }),
    );
    return this.availability;
  }

  /** Runs one git command in this repository's queue. Throws GitError. */
  async run(args: string[], opts: GitRunOptions): Promise<GitResult> {
    const available = await this.check();
    if (!available.ok) throw new GitError("not_installed", available.reason);
    return this.serial(opts.repo ?? opts.cwd, () => this.spawnGit(args, opts));
  }

  /**
   * Runs `task` after every earlier queued command on `repo` has finished. Use it to keep a
   * multi-command sequence (check, add, commit) together; inside it, call `spawn` via `runNow`.
   */
  serial<T>(repo: string, task: () => Promise<T>): Promise<T> {
    const key = path.resolve(repo);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  /** Like `run`, but without queueing (the caller already holds the repo's queue via `serial`). */
  async runNow(args: string[], opts: GitRunOptions): Promise<GitResult> {
    const available = await this.check();
    if (!available.ok) throw new GitError("not_installed", available.reason);
    return this.spawnGit(args, opts);
  }

  /**
   * Throws GitError "busy" when the repository has an index.lock, or a merge, rebase,
   * cherry-pick or revert in progress. `gitDir` is `git rev-parse --absolute-git-dir`.
   */
  async checkNotBusy(gitDir: string, repoRoot: string): Promise<void> {
    const markers: [string, string][] = [
      ["index.lock", "index.lock exists"],
      ["MERGE_HEAD", "a merge is in progress"],
      ["rebase-merge", "a rebase is in progress"],
      ["rebase-apply", "a rebase is in progress"],
      ["CHERRY_PICK_HEAD", "a cherry-pick is in progress"],
      ["REVERT_HEAD", "a revert is in progress"],
    ];
    for (const [name, reason] of markers) {
      const exists = await fs
        .lstat(path.join(gitDir, name))
        .then(() => true)
        .catch(() => false);
      if (exists)
        throw new GitError("busy", `Git is busy in ${repoRoot} (${reason}). Finish it, then try again.`);
    }
  }

  private spawnGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    for (const name of REPO_ENV) delete env[name];
    if (opts.read) env.GIT_OPTIONAL_LOCKS = "0";
    else delete env.GIT_OPTIONAL_LOCKS;
    const config = ["-c", "core.fsmonitor=false"];
    for (const [key, value] of Object.entries(opts.config ?? {})) config.push("-c", `${key}=${value}`);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const okCodes = opts.okCodes ?? [0];

    return new Promise((resolve, reject) => {
      // detached: its own process group, so a timeout also stops hooks and helpers git started.
      const detached = process.platform !== "win32";
      let child;
      try {
        child = spawn("git", [...config, ...args], {
          cwd: opts.cwd,
          env,
          shell: false,
          detached,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(new GitError("not_installed", `Git couldn't start: ${(error as Error).message}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const combined = () =>
        tail(
          [Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")]
            .filter(Boolean)
            .join("\n"),
        );
      const timer = setTimeout(() => {
        try {
          if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        finish(() =>
          reject(
            new GitError(
              "timeout",
              `git ${args[0] ?? ""} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
              combined(),
            ),
          ),
        );
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            error.code === "ENOENT"
              ? new GitError("not_installed", "Git isn't installed (no git command on PATH).")
              : new GitError("failed", `Git couldn't start: ${error.message}`),
          ),
        ),
      );
      child.on("close", (code) =>
        finish(() => {
          const stdout = Buffer.concat(out);
          const stderr = Buffer.concat(err).toString("utf8");
          const exit = code ?? -1;
          if (okCodes.includes(exit)) return resolve({ stdout, stderr, code: exit });
          if (/not a git repository/i.test(stderr))
            return reject(new GitError("not_repo", "Not in a git repository.", combined(), exit));
          const busy = busyReason(stderr);
          if (busy)
            return reject(
              new GitError("busy", `Git is busy in ${opts.repo ?? opts.cwd} (${busy}).`, combined(), exit),
            );
          const firstLine = stderr.split("\n").find((line) => line.trim()) ?? `exit code ${exit}`;
          reject(
            new GitError("failed", `git ${args[0] ?? ""} failed: ${firstLine.trim()}`, combined(), exit),
          );
        }),
      );
      child.stdin.on("error", () => {
        // git may exit before reading stdin; the exit code tells what happened.
      });
      child.stdin.end(opts.input ?? undefined);
    });
  }
}
