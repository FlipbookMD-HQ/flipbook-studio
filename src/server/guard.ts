import crypto from "node:crypto";
import { TOKEN_HEADER } from "../shared/api.js";
import { StudioError } from "./errors.js";

/** A fresh 32-byte launch token. It lives only in memory and in the served index.html. */
export function createToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Constant-time token comparison. Exported on an object so tests can spy on it. */
export const compare = {
  timingSafeEqual: (a: Buffer, b: Buffer): boolean => crypto.timingSafeEqual(a, b),
};

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  // timingSafeEqual needs equal lengths; compare against itself so the call still happens.
  if (a.length !== b.length) {
    compare.timingSafeEqual(a, a);
    return false;
  }
  return compare.timingSafeEqual(a, b);
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function forbidden(message: string): never {
  throw new StudioError(403, "FORBIDDEN_ORIGIN", message);
}

/** Host allowlist: blocks DNS rebinding. Applies to every route, including index.html and files/*. */
export function checkHost(headers: Headers, port: number): void {
  const host = headers.get("host");
  if (!host || !allowedHosts(port).has(host.toLowerCase())) forbidden("Request Host is not this Studio.");
}

/** Full /api guard: Host, Origin, Sec-Fetch-Site and the launch token. */
export function checkApiRequest(headers: Headers, port: number, token: string): void {
  checkHost(headers, port);
  const origin = headers.get("origin");
  if (origin != null) {
    let originHost: string;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:") forbidden("Request Origin is not this Studio.");
      originHost = parsed.host.toLowerCase();
    } catch (error) {
      if (error instanceof StudioError) throw error;
      forbidden("Request Origin is not this Studio.");
    }
    if (originHost !== headers.get("host")?.toLowerCase()) forbidden("Request Origin is not this Studio.");
  }
  const site = headers.get("sec-fetch-site");
  if (site != null && site !== "same-origin" && site !== "none")
    forbidden("Cross-site requests are refused.");
  if (!tokenMatches(token, headers.get(TOKEN_HEADER))) forbidden("Missing or wrong Studio token.");
}
