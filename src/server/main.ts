import { main } from "./launcher.js";

const code = await main(process.argv.slice(2));
if (code != null) process.exit(code);
