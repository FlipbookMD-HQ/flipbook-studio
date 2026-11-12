import { defineConfig, devices } from "@playwright/test";

const studio = (workspace: string, port: number) => ({
  command: `node bin/flipbook-studio.js ${workspace} --no-open --port ${port}`,
  url: `http://127.0.0.1:${port}/`,
  reuseExistingServer: false,
  env: { FLIPBOOK_HOME: "fixtures/library" },
});

const fresh = (workspace: string, port: number, source = "") => {
  const server = studio(workspace, port);
  return { ...server, command: `node e2e/fresh-workspace.mjs ${workspace} ${source} && ${server.command}` };
};

export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Desktop Chrome"] },
  webServer: [
    studio("fixtures/ws", 4391),
    studio("fixtures/empty", 4392),
    // Fresh, writable workspaces: an empty one for creating decks, a copy of fixtures/edit for editing.
    fresh(".e2e-workspace", 4393),
    fresh(".e2e-edit", 4394, "fixtures/edit"),
    // Present and export, on a PATH without ffmpeg: PNG export works, video reports ffmpeg missing.
    {
      ...fresh(".e2e-export", 4395, "fixtures/edit"),
      command: `"${process.execPath}" e2e/fresh-workspace.mjs .e2e-export fixtures/edit && "${process.execPath}" bin/flipbook-studio.js .e2e-export --no-open --port 4395`,
      env: { FLIPBOOK_HOME: "fixtures/library", PATH: "/usr/bin:/bin" },
    },
    // Theme editor: a fresh workspace and a fresh, empty library.
    {
      ...studio(".e2e-kits", 4396),
      command: `"${process.execPath}" e2e/fresh-workspace.mjs .e2e-kits fixtures/kits && "${process.execPath}" e2e/fresh-workspace.mjs .e2e-library && "${process.execPath}" bin/flipbook-studio.js .e2e-kits --no-open --port 4396 --library .e2e-library`,
    },
  ],
});
