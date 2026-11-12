import { defineConfig, devices } from "@playwright/test";

const studio = (workspace: string, port: number) => ({
  command: `node bin/flipbook-studio.js ${workspace} --no-open --port ${port}`,
  url: `http://127.0.0.1:${port}/`,
  reuseExistingServer: false,
  env: { FLIPBOOK_HOME: "fixtures/library" },
});

export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Desktop Chrome"] },
  webServer: [studio("fixtures/ws", 4391), studio("fixtures/empty", 4392)],
});
