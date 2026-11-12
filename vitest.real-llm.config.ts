import { defineConfig } from "vitest/config";

// The nightly real-model suite: `npx vitest run --config vitest.real-llm.config.ts`.
export default defineConfig({
  test: {
    include: ["test/real-llm/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 180_000,
  },
});
