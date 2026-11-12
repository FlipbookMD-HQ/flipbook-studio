import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin/flipbook-studio.js");
const built =
  existsSync(path.join(root, "dist/server/main.js")) && existsSync(path.join(root, "dist/ui/index.html"));

// Runs against `npm run build` output. CI builds before testing.
describe.skipIf(!built)("built server", () => {
  it("starts, prints the URL and serves the UI shell and its bundle", async () => {
    const child = spawn(process.execPath, [bin, "fixtures/ws", "--no-open", "--port", "4399"], {
      cwd: root,
      env: { ...process.env, FLIPBOOK_HOME: path.join(root, "fixtures/library") },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = /URL: +(http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
          if (match?.[1]) resolve(match[1]);
        });
        child.once("exit", (code) => reject(new Error(`exited ${code}: ${output}`)));
      });
      const html = await (await fetch(url)).text();
      expect(html).toMatch(/<meta name="flipbook-token" content="[A-Za-z0-9_-]{43}"/);
      const script = /<script type="module" crossorigin src="([^"]+)"/.exec(html)?.[1];
      expect(script).toBeTruthy();
      const bundle = await fetch(new URL(script!, url));
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toContain("javascript");
    } finally {
      child.kill();
    }
  });

  it.each([
    [["--bogus"], 1],
    [["does-not-exist"], 2],
    [["package.json"], 2],
  ])("exits with the right code for %j", (args, code) => {
    const result = spawnSync(process.execPath, [bin, ...args, "--no-open"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(code);
  });
});
