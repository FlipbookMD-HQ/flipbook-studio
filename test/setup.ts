import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests never read or write the real settings.json.
process.env.FLIPBOOK_STUDIO_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "studio-config-"));
