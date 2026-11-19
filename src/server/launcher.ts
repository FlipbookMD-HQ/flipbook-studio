import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import { createToken } from "./guard.js";
import { SettingsStore, configDir } from "./settings.js";
import { normalizeBaseUrl } from "./llm/provider.js";
import { resetGenerationTemp } from "./ai/generate.js";

export const DEFAULT_PORT = 4321;
export const HOST = "127.0.0.1";

export const EXIT = { ok: 0, usage: 1, workspace: 2, library: 3, bind: 4 } as const;

export class LaunchError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LaunchOptions {
  workspace: string;
  port: number;
  open: boolean;
  library: string;
}

export const USAGE = `Flipbook Studio

Usage:
  flipbook-studio [workspace] [--port <n>] [--no-open] [--library <dir>]

Options:
  --port <n>         Port to try first (default ${DEFAULT_PORT}; a free port is used when it is busy)
  --no-open          Print the URL without opening a browser
  --library <dir>    Library for themes, templates and kits (default ~/Documents/flipbook)
  -h, --help         Show this help`;

export function defaultLibrary(): string {
  const override = process.env.FLIPBOOK_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), "Documents", "flipbook");
}

export function parseArgs(argv: string[]): LaunchOptions | "help" {
  const options: LaunchOptions = {
    workspace: ".",
    port: DEFAULT_PORT,
    open: true,
    library: defaultLibrary(),
  };
  let workspaceSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next == null || next.startsWith("--")) throw new LaunchError(EXIT.usage, `${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--no-open") options.open = false;
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new LaunchError(EXIT.usage, "--port must be an integer from 1 to 65535.");
      options.port = port;
    } else if (arg === "--library") options.library = path.resolve(value());
    else if (arg.startsWith("-")) throw new LaunchError(EXIT.usage, `Unknown option: ${arg}`);
    else if (workspaceSet) throw new LaunchError(EXIT.usage, "Pass only one workspace folder.");
    else {
      options.workspace = arg;
      workspaceSet = true;
    }
  }
  options.workspace = path.resolve(options.workspace);
  return options;
}

export async function checkWorkspace(workspace: string): Promise<string> {
  const stat = await fs.stat(workspace).catch(() => null);
  if (!stat) throw new LaunchError(EXIT.workspace, `Workspace does not exist: ${workspace}`);
  if (!stat.isDirectory()) throw new LaunchError(EXIT.workspace, `Workspace is not a folder: ${workspace}`);
  return fs.realpath(workspace);
}

export async function checkLibrary(library: string): Promise<void> {
  try {
    await fs.mkdir(library, { recursive: true });
    await fs.access(library, fs.constants.W_OK);
  } catch {
    throw new LaunchError(EXIT.library, `Library folder is not writable: ${library}`);
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("No port")),
      );
    });
  });
}

function listen(
  app: ReturnType<typeof createApp>,
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) =>
      resolve({ server, port: info.port }),
    );
    server.once("error", reject);
  });
}

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

export function uiDir(): string {
  // dist/server/main.js → dist/ui
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

/** The banner's LLM line: `<model> @ <baseUrl>`, or why there is none. */
export function llmBanner(settings: SettingsStore): string {
  const llm = settings.current().llm;
  if (!llm) return "not configured (Settings in the app)";
  return `${llm.model ?? "no model chosen"} @ ${normalizeBaseUrl(llm.baseUrl)}`;
}

export interface Launched {
  server: ServerType;
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function launch(
  options: LaunchOptions,
  deps: { open?: (url: string) => void; log?: (line: string) => void; uiDir?: string } = {},
): Promise<Launched> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const workspace = await checkWorkspace(options.workspace);
  await checkLibrary(options.library);
  // A crash mid-generation leaves a run folder; nothing in it is ever needed again (D17).
  await resetGenerationTemp(workspace).catch(() => {});
  // Core reads the library location from FLIPBOOK_HOME.
  process.env.FLIPBOOK_HOME = options.library;

  const settings = await SettingsStore.open(configDir(), log);
  const token = createToken();
  let boundPort = 0;
  const app = createApp({
    workspace,
    library: options.library,
    token,
    port: () => boundPort,
    uiDir: deps.uiDir ?? uiDir(),
    log,
    settings,
  });

  let bound: { server: ServerType; port: number };
  try {
    const first = (await portFree(options.port)) ? options.port : await freePort();
    bound = await listen(app, first);
  } catch (error) {
    throw new LaunchError(EXIT.bind, `Could not listen on ${HOST}: ${(error as Error).message}`);
  }
  boundPort = bound.port;
  const url = `http://${HOST}:${bound.port}/`;
  if (bound.port !== options.port) log(`Port ${options.port} is busy; using ${bound.port}.`);
  log(
    `Flipbook Studio\n  URL:       ${url}\n  Workspace: ${workspace}\n  Library:   ${options.library}\n  LLM:       ${llmBanner(settings)}`,
  );
  // US-23 (D43): git is checked once, at startup; without git 2.30+ only History is off.
  const git = await app.git.check();
  if (!git.ok) log(`Warning: ${git.reason} Version history is off; everything else works.`);
  if (options.open) (deps.open ?? openBrowser)(url);

  return {
    server: bound.server,
    url,
    port: bound.port,
    token,
    close: async () => {
      await app.shutdown();
      // close() waits for every open connection; an open tab or a streaming request would keep
      // Studio running after Ctrl+C, so drop them once no new ones are accepted.
      const closed = new Promise<void>((resolve) => bound.server.close(() => resolve()));
      (bound.server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await closed;
    },
  };
}

/** CLI entry. Returns the exit code for failures; on success the server keeps the process alive. */
export async function main(argv: string[]): Promise<number | null> {
  try {
    const options = parseArgs(argv);
    if (options === "help") {
      console.log(USAGE);
      return EXIT.ok;
    }
    const launched = await launch(options);
    const stop = () => launched.close().then(() => process.exit(EXIT.ok));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return null;
  } catch (error) {
    if (error instanceof LaunchError) {
      console.error(error.message);
      if (error.exitCode === EXIT.usage) console.error(`\n${USAGE}`);
      return error.exitCode;
    }
    throw error;
  }
}
