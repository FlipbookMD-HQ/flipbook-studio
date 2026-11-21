import { describe, expect, it, vi } from "vitest";
import { compare, createToken, tokenMatches } from "../src/server/guard.js";
import { createApp, MAX_BODY_BYTES } from "../src/server/app.js";
import { TOKEN_PLACEHOLDER } from "../src/shared/api.js";
import { PORT, TOKEN, headers, makeApp, tempDir, write } from "./helpers.js";

const wrongToken = `${TOKEN.slice(0, -1)}b`;

describe("local guard on /api", () => {
  const cases: Array<[string, Record<string, string | null>, number]> = [
    ["valid request", {}, 200],
    ["valid request via localhost", { host: "localhost:4321" }, 200],
    [
      "same Origin and same-origin fetch",
      { origin: "http://127.0.0.1:4321", "sec-fetch-site": "same-origin" },
      200,
    ],
    ["DNS rebinding Host", { host: "attacker.com" }, 403],
    ["right host, wrong port", { host: "127.0.0.1:9999" }, 403],
    ["cross-site Origin", { origin: "https://evil.test" }, 403],
    ["Origin on another port", { origin: "http://127.0.0.1:9999" }, 403],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, 403],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }, 403],
    ["no token", { "x-flipbook-token": null }, 403],
    ["token with one character changed", { "x-flipbook-token": wrongToken }, 403],
    ["token of another length", { "x-flipbook-token": "short" }, 403],
  ];

  it.each(cases)("%s → %i", async (_name, extra, status) => {
    const app = await makeApp(await tempDir());
    const response = await app.request("/api/workspace", { headers: headers(extra) });
    expect(response.status).toBe(status);
    if (status === 403) {
      expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN_ORIGIN" } });
    }
  });

  it("compares tokens with timingSafeEqual", async () => {
    const spy = vi.spyOn(compare, "timingSafeEqual");
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, wrongToken)).toBe(false);
    expect(tokenMatches(TOKEN, "short")).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("creates a new 32-byte token every launch", () => {
    const first = createToken();
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(createToken()).not.toBe(first);
  });

  it("rejects bodies over 2 MB with 413", async () => {
    const app = await makeApp(await tempDir());
    const response = await app.request("/api/workspace", {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("serves the install files, and a client route still gets the shell", async () => {
    const uiDir = await tempDir("studio-ui-");
    await write(uiDir, {
      "index.html": `<meta name="flipbook-token" content="${TOKEN_PLACEHOLDER}">`,
      "manifest.webmanifest": '{"name":"Flipbook Studio"}',
      "sw.js": "self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));",
      "icons/icon-192.png": "png",
    });
    const app = await createApp({
      workspace: await tempDir(),
      library: await tempDir(),
      token: TOKEN,
      port: () => PORT,
      uiDir,
      log: () => {},
    });
    const manifest = await app.request("/manifest.webmanifest", {
      headers: headers({ "x-flipbook-token": null }),
    });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(await manifest.text()).toContain("Flipbook Studio");
    const worker = await app.request("/sw.js", { headers: headers({ "x-flipbook-token": null }) });
    expect(worker.headers.get("content-type")).toContain("text/javascript");
    const icon = await app.request("/icons/icon-192.png", { headers: headers({ "x-flipbook-token": null }) });
    expect(icon.headers.get("content-type")).toBe("image/png");
    const route = await app.request("/decks/abc", { headers: headers({ "x-flipbook-token": null }) });
    expect(await route.text()).toContain(`content="${TOKEN}"`);
    const missing = await app.request("/icons/missing.png", {
      headers: headers({ "x-flipbook-token": null }),
    });
    expect(missing.status).toBe(404);
    const rebound = await app.request("/manifest.webmanifest", {
      headers: headers({ host: "attacker.com" }),
    });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("Flipbook Studio");
  });

  it("serves index.html with the token only after the Host check", async () => {
    const app = await makeApp(await tempDir());
    const ok = await app.request("/", { headers: headers({ "x-flipbook-token": null }) });
    expect(await ok.text()).toContain(`content="${TOKEN}"`);
    expect(ok.headers.get("content-security-policy")).toContain("script-src 'self'");
    const rebound = await app.request("/", { headers: headers({ host: "attacker.com" }) });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain(TOKEN);
  });

  it("answers unknown API routes with NOT_FOUND and a request ID", async () => {
    const app = await makeApp(await tempDir());
    const response = await app.request("/api/nope", { headers: headers() });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "No such API route." } });
  });
});
