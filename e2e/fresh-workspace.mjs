// Usage: node e2e/fresh-workspace.mjs <dir> [source]. Empties <dir>, then copies [source] into it.
import fs from "node:fs";
const [dir, source] = process.argv.slice(2);
fs.rmSync(dir, { recursive: true, force: true });
if (source) fs.cpSync(source, dir, { recursive: true });
else fs.mkdirSync(dir);
