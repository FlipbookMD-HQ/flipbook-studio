import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "../../src/server/history/git.js";

// US-23 test support: real git in temporary repositories, never this checkout, and never the
// user's global or system git config (HOME and GIT_CONFIG_GLOBAL point at an empty temp folder).

const home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-git-home-"));
export const GLOBAL_GIT_CONFIG = path.join(home, "gitconfig");

/** Studio's environment for tests: no global or system git config, no author from the env. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: GLOBAL_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ])
    if (!(name in extra)) delete env[name];
  return env;
}

/** Runs the test's own git (setting up fixtures); returns stdout as text. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** Like `git`, with an author, for commits made "outside Studio". */
export function gitAs(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Outside", "-c", "user.email=outside@example.com", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** `git init` with a local author (repo config, never global) and a fixed branch name. */
export function initRepo(dir: string, { author = true } = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  if (author) {
    git(dir, "config", "user.name", "Test Author");
    git(dir, "config", "user.email", "test@example.com");
  }
}

export const runner = (options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) =>
  new GitRunner({ env: gitEnv(options.env), timeoutMs: options.timeoutMs });

export const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** A folder holding a fake `git` script (POSIX sh), for PATH. */
export function fakeGit(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-fake-git-"));
  fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}
