import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** A Studio of its own (port, workspace and settings folder), for specs that need an LLM stub or a restart. */
export async function startStudio(
  workspace: string,
  configDir: string,
  port: number,
): Promise<{ url: string; banner: string; child: ChildProcess }> {
  const child = spawn(
    process.execPath,
    ["bin/flipbook-studio.js", workspace, "--no-open", "--port", String(port)],
    {
      env: {
        ...process.env,
        FLIPBOOK_HOME: path.resolve("fixtures/library"),
        FLIPBOOK_STUDIO_CONFIG_DIR: configDir,
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

export const stopStudio = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
