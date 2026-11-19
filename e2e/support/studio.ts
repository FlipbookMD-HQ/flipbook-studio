import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** A Studio of its own (port, workspace and settings folder), for specs that need an LLM stub or a restart. */
export async function startStudio(
  workspace: string,
  configDir: string,
  port: number,
  /** The library folder (FLIPBOOK_HOME); defaults to fixtures/library. */
  library = path.resolve("fixtures/library"),
  /** Extra environment: fake provider URLs (US-21), or an isolated HOME and git config (US-23). */
  env: NodeJS.ProcessEnv = {},
): Promise<{ url: string; banner: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    ["bin/flipbook-studio.js", workspace, "--no-open", "--port", String(port)],
    {
      env: {
        ...process.env,
        FLIPBOOK_HOME: library,
        FLIPBOOK_STUDIO_CONFIG_DIR: configDir,
        ...env,
      },
    },
  );
  let out = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      out += String(chunk);
      const match = /URL: +(http:\/\/\S+)/.exec(out);
      if (match && /LLM:.*\n/.test(out)) resolve(match[1]!);
    });
    child.on("exit", (code) => reject(new Error(`Studio exited ${code}: ${out}`)));
  });
  return { url, banner: out, child };
}

/** Stops Studio; one that hasn't exited after 10 s is killed so a stuck shutdown fails loudly. */
export const stopStudio = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Studio didn't stop within 10 s of SIGTERM."));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
