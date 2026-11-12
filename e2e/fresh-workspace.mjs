// Empties .e2e-workspace before the create-deck server starts.
import fs from "node:fs";
fs.rmSync(".e2e-workspace", { recursive: true, force: true });
fs.mkdirSync(".e2e-workspace");
