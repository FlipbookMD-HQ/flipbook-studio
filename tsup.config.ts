import { defineConfig } from "tsup";

// Builds the server. Runtime dependencies stay external and load from node_modules.
export default defineConfig({
  entry: { main: "src/server/main.ts" },
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
});
