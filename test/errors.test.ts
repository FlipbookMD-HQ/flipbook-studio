import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { errorHandler, type Env } from "../src/server/app.js";
import { StudioError } from "../src/server/errors.js";

function probe(logs: string[]) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("requestId", "abcd1234");
    await next();
  });
  app.get("/typed", () => {
    throw new StudioError(404, "DECK_NOT_FOUND", "No deck with that ID.", { path: "x" });
  });
  app.get("/zod", () => {
    z.object({ name: z.string() }).parse({ name: 3 });
    return new Response("unreachable");
  });
  app.get("/boom", () => {
    throw new Error("secret internals");
  });
  app.onError(errorHandler((line) => logs.push(line)));
  return app;
}

describe("error envelope", () => {
  it("maps a typed error to its status and code", async () => {
    const response = await probe([]).request("/typed");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "DECK_NOT_FOUND", message: "No deck with that ID.", path: "x" },
    });
  });

  it("maps a zod failure to 422 with details.fields", async () => {
    const response = await probe([]).request("/zod");
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details.fields).toEqual([{ path: "name", message: expect.any(String) }]);
  });

  it("hides unmapped errors behind 500 INTERNAL and logs the stack with the request ID", async () => {
    const logs: string[] = [];
    const response = await probe(logs).request("/boom");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret internals");
    expect(JSON.parse(text).error).toEqual({
      code: "INTERNAL",
      message: "Something went wrong. Request ID: abcd1234.",
    });
    expect(logs.join("\n")).toMatch(/abcd1234 INTERNAL Error: secret internals\n\s+at /);
  });
});
