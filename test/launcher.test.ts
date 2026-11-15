import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, LaunchError, launch, parseArgs, type Launched } from "../src/server/launcher.js";
import { tempDir, write } from "./helpers.js";

const running: Launched[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

async function uiDir() {
  const dir = await tempDir("studio-ui-");
  await write(dir, { "index.html": '<meta name="flipbook-token" content="__FLIPBOOK_TOKEN__">' });
  return dir;
}

async function start(overrides: Partial<Parameters<typeof launch>[0]> = {}, open = vi.fn()) {
  const logs: string[] = [];
  const launched = await launch(
    { workspace: await tempDir(), port: 0, open: false, library: await tempDir("studio-lib-"), ...overrides },
    { open, log: (line) => logs.push(line), uiDir: await uiDir() },
  );
  running.push(launched);
  return { launched, logs, open };
}

describe("parseArgs", () => {
  it("defaults to the current folder, port 4321 and opening the browser", () => {
    expect(parseArgs([])).toMatchObject({ workspace: process.cwd(), port: 4321, open: true });
  });

  it("reads the workspace and every option", () => {
    expect(parseArgs(["decks", "--port", "5000", "--no-open", "--library", "lib"])).toEqual({
      workspace: path.resolve("decks"),
      port: 5000,
      open: false,
      library: path.resolve("lib"),
    });
  });

  it.each([["--port"], ["--port", "abc"], ["--port", "70000"], ["--host", "0.0.0.0"], ["a", "b"]])(
    "exits 1 for %j",
    (...argv) => {
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ exitCode: EXIT.usage }));
    },
  );
});

describe("launch", () => {
  it("exits 2 for a missing workspace", async () => {
    await expect(start({ workspace: "/definitely/not/here" })).rejects.toMatchObject({
      exitCode: EXIT.workspace,
    });
  });

  it("exits 2 when the workspace is a file", async () => {
    const dir = await tempDir();
    await write(dir, { "deck.slide.md": "# Hi" });
    await expect(start({ workspace: path.join(dir, "deck.slide.md") })).rejects.toMatchObject({
      exitCode: EXIT.workspace,
    });
  });

  it("exits 3 when the library is not writable", async () => {
    const dir = await tempDir();
    await fs.chmod(dir, 0o500);
    try {
      await expect(start({ library: path.join(dir, "lib") })).rejects.toBeInstanceOf(LaunchError);
      await expect(start({ library: path.join(dir, "lib") })).rejects.toMatchObject({
        exitCode: EXIT.library,
      });
    } finally {
      await fs.chmod(dir, 0o700);
    }
  });

  it("falls back to a free port when the requested one is busy, and prints the banner", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const { launched, logs } = await start({ port: busy });
      expect(launched.port).not.toBe(busy);
      expect(launched.url).toBe(`http://127.0.0.1:${launched.port}/`);
      const output = logs.join("\n");
      expect(output).toContain(`Port ${busy} is busy; using ${launched.port}.`);
      expect(output).toMatch(/URL: +http:\/\/127\.0\.0\.1:\d+\//);
      expect(output).toMatch(/Workspace: /);
      expect(output).toMatch(/Library: /);
      expect(output).toMatch(/LLM: +not configured/);
    } finally {
      blocker.close();
    }
  });

  it("binds 127.0.0.1 only and serves the shell with this launch's token", async () => {
    const { launched } = await start();
    expect((launched.server.address() as net.AddressInfo).address).toBe("127.0.0.1");
    const html = await (await fetch(launched.url)).text();
    expect(html).toContain(`content="${launched.token}"`);
  });

  it("uses a new token for every launch", async () => {
    const first = await start();
    const second = await start();
    expect(first.launched.token).not.toBe(second.launched.token);
  });

  it("opens the browser unless --no-open", async () => {
    const quiet = await start({ open: false });
    expect(quiet.open).not.toHaveBeenCalled();
    const loud = await start({ open: true });
    expect(loud.open).toHaveBeenCalledWith(loud.launched.url);
  });

  it("closes even while a client holds a connection open mid-request", async () => {
    const { launched } = await start();
    running.pop();
    const socket = net.connect(launched.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    // Headers never finished: an active connection that server.close() alone would wait on.
    socket.write("GET /api/workspace HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    socket.on("error", () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await launched.close();
    expect(Date.now() - started).toBeLessThan(2000);
    socket.destroy();
  });
});
