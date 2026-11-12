import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { TOKEN_PLACEHOLDER } from "../src/shared/api.js";

export const PORT = 4321;
export const TOKEN = "a".repeat(43);

export async function tempDir(prefix = "studio-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

export async function makeApp(workspace: string, logs: string[] = []) {
  const uiDir = await tempDir("studio-ui-");
  await write(uiDir, {
    "index.html": `<meta name="flipbook-token" content="${TOKEN_PLACEHOLDER}"><div id="root"></div>`,
    "assets/app.js": "console.log('ui');",
  });
  const library = await tempDir("studio-lib-");
  return createApp({
    workspace,
    library,
    token: TOKEN,
    port: () => PORT,
    uiDir,
    log: (line) => logs.push(line),
  });
}

export function headers(extra: Record<string, string | null> = {}): Headers {
  const base: Record<string, string | null> = {
    host: `127.0.0.1:${PORT}`,
    "x-flipbook-token": TOKEN,
    ...extra,
  };
  const result = new Headers();
  for (const [key, value] of Object.entries(base)) if (value != null) result.set(key, value);
  return result;
}

export const SINGLE_DECK = "---\ntitle: Single\n---\n# One\n\nHello.\n\n---\n\n# Two\n\nWorld.\n";
export const FOLDER_DECK = {
  "presentation.yml": "title: Folder deck\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n",
  "slides/01.slide.md": "# First\n\n![logo](../assets/logo.svg)\n",
  "slides/02.slide.md": "# Second\n\nText.\n",
  "assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
};
