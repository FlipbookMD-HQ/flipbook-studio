import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/real-llm/**"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
