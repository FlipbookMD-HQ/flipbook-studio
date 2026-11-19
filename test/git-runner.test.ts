import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitError, busyReason, parseGitVersion } from "../src/server/history/git.js";
import { fakeGit, gitEnv, initRepo, realGit, runner } from "./support/git.js";
import { tempDir } from "./helpers.js";

// US-23 (D36, D43): GitRunner runs git without a shell, with a fixed environment, a timeout,
// one queue per repository, typed errors and a version check.

const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof GitError ? error.kind : `not a GitError: ${String(error)}`;
  }
  return "resolved";
};

describe("git version", () => {
  it("parses git's version line", () => {
    expect(parseGitVersion("git version 2.39.3 (Apple Git-145)")).toEqual([2, 39]);
    expect(parseGitVersion("git version 2.56.0\n")).toEqual([2, 56]);
    expect(parseGitVersion("not git")).toBeNull();
  });

  it("reports the installed git as available", async () => {
    const check = await runner().check();
    expect(check.ok).toBe(true);
  });

  it("missing git → not_installed, and every command refuses", async () => {
    const empty = await tempDir("studio-no-git-");
    const git = runner({ env: { PATH: empty } });
    const check = await git.check();
    expect(check).toEqual({ ok: false, reason: expect.stringMatching(/Git isn't installed/) });
    expect(await kindOf(git.run(["status"], { cwd: empty }))).toBe("not_installed");
  });

  it("git older than 2.30 → not_installed", async () => {
    const dir = fakeGit('echo "git version 2.29.2"');
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` } });
    expect(await git.check()).toEqual({ ok: false, reason: expect.stringMatching(/2\.30 or newer.*2\.29/) });
    expect(await kindOf(git.run(["status"], { cwd: dir }))).toBe("not_installed");
  });

  it("checks the version only once", async () => {
    const dir = fakeGit(`echo run >> "${"$"}(dirname "$0")/calls"; echo "git version 2.40.0"`);
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` } });
    await git.check();
    await git.run(["status"], { cwd: dir });
    await git.run(["status"], { cwd: dir });
    // One --version, two status calls.
    expect((await fs.readFile(path.join(dir, "calls"), "utf8")).trim().split("\n")).toHaveLength(3);
  });
});

describe("running git", () => {
  it("passes arguments without a shell, with the fixed env and fsmonitor off", async () => {
    const dir = fakeGit(
      [
        'case "$*" in *--version*) echo "git version 2.40.0"; exit 0;; esac',
        'for arg in "$@"; do printf "%s\\n" "$arg"; done',
        'echo "PROMPT=$GIT_TERMINAL_PROMPT LC_ALL=$LC_ALL LOCKS=$GIT_OPTIONAL_LOCKS GIT_DIR=$GIT_DIR"',
      ].join("\n"),
    );
    const git = runner({
      env: { PATH: `${dir}:/usr/bin:/bin`, GIT_DIR: "/elsewhere", GIT_OPTIONAL_LOCKS: "1" },
    });
    const hostile = "$(touch pwned); `id` | ; && -rf";
    const read = (await git.run(["log", "--", hostile], { cwd: dir, read: true })).stdout.toString();
    expect(read.split("\n").slice(0, 5)).toEqual(["-c", "core.fsmonitor=false", "log", "--", hostile]);
    expect(read).toContain("PROMPT=0 LC_ALL=C LOCKS=0 GIT_DIR=\n");
    const write = (await git.run(["add", "-A"], { cwd: dir })).stdout.toString();
    expect(write).toContain("LOCKS= ");
    await expect(fs.stat(path.join(dir, "pwned"))).rejects.toThrow();
  });

  it("adds -c settings for one command only", async () => {
    const dir = fakeGit(
      ['case "$*" in *--version*) echo "git version 2.40.0"; exit 0;; esac', 'printf "%s\\n" "$@"'].join(
        "\n",
      ),
    );
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` } });
    const out = (
      await git.run(["commit"], { cwd: dir, config: { "user.name": "A -c x", "user.email": "a@b.c" } })
    ).stdout.toString();
    expect(out.split("\n").slice(0, 7)).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "user.name=A -c x",
      "-c",
      "user.email=a@b.c",
      "commit",
    ]);
  });

  it("stops a hanging git after the timeout (and its children)", async () => {
    const dir = fakeGit(
      ['case "$*" in *--version*) echo "git version 2.40.0"; exit 0;; esac', "sleep 30"].join("\n"),
    );
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` }, timeoutMs: 300 });
    const started = Date.now();
    let caught: unknown;
    try {
      await git.run(["commit"], { cwd: dir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitError);
    expect([(caught as GitError).kind, (caught as GitError).message]).toEqual(["timeout", expect.anything()]);
    expect((caught as GitError).message).toMatch(/longer than/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps only the last 4 kB of git's output on failure", async () => {
    const dir = fakeGit(
      [
        'case "$*" in *--version*) echo "git version 2.40.0"; exit 0;; esac',
        'i=0; while [ $i -lt 400 ]; do echo "line $i of hook output" >&2; i=$((i+1)); done',
        "echo LAST >&2; exit 1",
      ].join("\n"),
    );
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` } });
    let caught: GitError | null = null;
    try {
      await git.run(["commit"], { cwd: dir });
    } catch (error) {
      caught = error as GitError;
    }
    expect(caught?.kind).toBe("failed");
    expect(Buffer.byteLength(caught!.output)).toBeLessThanOrEqual(4096);
    expect(caught!.output.trimEnd().endsWith("LAST")).toBe(true);
  });

  it("allows exit codes the caller expects", async () => {
    const repo = await tempDir("studio-git-ok-");
    initRepo(repo);
    const result = await runner().run(["check-ignore", "-q", "--", "x"], { cwd: repo, okCodes: [0, 1] });
    expect(result.code).toBe(1);
  });

  it("outside a repository → not_repo", async () => {
    const dir = await tempDir("studio-git-none-");
    expect(await kindOf(runner().run(["status"], { cwd: dir, read: true }))).toBe("not_repo");
  });

  it("runs one command at a time per repository", async () => {
    const dir = fakeGit(
      [
        'case "$*" in *--version*) echo "git version 2.40.0"; exit 0;; esac',
        'log="$(dirname "$0")/order"',
        'echo "start $3" >> "$log"; sleep 0.1; echo "end $3" >> "$log"',
      ].join("\n"),
    );
    const git = runner({ env: { PATH: `${dir}:/usr/bin:/bin` } });
    await Promise.all(["a", "b", "c"].map((name) => git.run([name], { cwd: dir, repo: "/repo" })));
    expect((await fs.readFile(path.join(dir, "order"), "utf8")).trim().split("\n")).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });
});

describe("busy repositories", () => {
  it("maps git's lock and in-progress messages", () => {
    expect(busyReason("fatal: Unable to create '/r/.git/index.lock': File exists.")).toBe(
      "index.lock exists",
    );
    expect(busyReason("error: You have not concluded your merge (MERGE_HEAD exists).")).toBe(
      "a merge is in progress",
    );
    expect(busyReason("error: cherry-pick is already in progress")).toBe("a cherry-pick is in progress");
    expect(busyReason("fatal: some other error")).toBeNull();
  });

  it("index.lock → busy from git itself", async () => {
    const repo = await tempDir("studio-git-lock-");
    initRepo(repo);
    await fs.writeFile(path.join(repo, "a.txt"), "a");
    await fs.writeFile(path.join(repo, ".git", "index.lock"), "");
    expect(await kindOf(runner().run(["add", "-A", "--", "a.txt"], { cwd: repo }))).toBe("busy");
  });

  it.each([
    ["index.lock", /index\.lock/],
    ["MERGE_HEAD", /merge/],
    ["rebase-merge", /rebase/],
    ["rebase-apply", /rebase/],
    ["CHERRY_PICK_HEAD", /cherry-pick/],
  ])("%s in the git dir → busy", async (marker, reason) => {
    const repo = await tempDir("studio-git-busy-");
    initRepo(repo);
    await fs.mkdir(path.join(repo, ".git", marker), { recursive: true });
    const git = runner();
    let caught: GitError | null = null;
    try {
      await git.checkNotBusy(path.join(repo, ".git"), repo);
    } catch (error) {
      caught = error as GitError;
    }
    expect(caught?.kind).toBe("busy");
    expect(caught?.message).toMatch(reason);
    expect(caught?.message).toContain(repo);
  });
});

describe("repository config that runs commands", () => {
  it("never runs a configured fsmonitor", async () => {
    const repo = await tempDir("studio-git-fsmonitor-");
    initRepo(repo);
    const marker = path.join(repo, "fsmonitor-ran");
    await fs.writeFile(path.join(repo, "fsmonitor.sh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
    execFileSync(realGit, ["config", "core.fsmonitor", path.join(repo, "fsmonitor.sh")], {
      cwd: repo,
      env: gitEnv(),
    });
    // Sanity: plain git does run it in this repository.
    execFileSync(realGit, ["status"], { cwd: repo, env: gitEnv() });
    await fs.access(marker);
    await fs.rm(marker);

    const git = runner();
    await git.run(["status", "--porcelain", "-z"], { cwd: repo, read: true });
    await git.run(["add", "-A", "--", "fsmonitor.sh"], { cwd: repo });
    await expect(fs.access(marker)).rejects.toThrow();
  });
});
