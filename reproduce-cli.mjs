import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.BIOME_BIN ?? `${ROOT}/node_modules/.bin/biome`;

const { stderr } = spawnSync(BIN, ["lint", "react-dom.production.min.js"], { cwd: ROOT });

if ((stderr?.toString() ?? "").match(/stack overflow|overflowed its stack/)) {
  console.error("*** CRASH DETECTED ***");
  console.error("react-dom.production.min.js causes a stack overflow in biome lint");
  process.exit(1);
}

console.log("no crash");
