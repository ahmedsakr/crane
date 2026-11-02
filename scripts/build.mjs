import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run build`, without starting npm again for every step. Each npm start
 * takes seconds on a busy machine, and a build used to start five.
 *
 * The commands stay in package.json, so `build:packages`, `build:backend` and
 * web's `build` still work and mean the same thing on their own. Web's
 * `prebuild` is skipped on purpose: `build:packages` has just compiled contracts.
 * It exists for `npm run build -w web` alone, which is how Crane builds its dashboard.
 */

const root = fileURLToPath(new URL("../", import.meta.url));

/** Run a package script as npm would: in its directory, with local binaries on PATH.
 * Vite is installed under web/node_modules, while tsc and esbuild are at the root.
 * @param {string} dir
 * @param {string} name
 */
function run(dir, name) {
  const command = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.[name];
  if (typeof command !== "string") throw new Error(`No ${name} script in ${join(dir, "package.json")}`);
  const PATH = [join(dir, "node_modules", ".bin"), join(root, "node_modules", ".bin"), process.env.PATH].join(delimiter);
  const { status, error } = spawnSync(command, { cwd: dir, shell: true, stdio: "inherit", env: { ...process.env, PATH } });
  if (error) console.error(`Cannot run ${name}: ${error.message}`);
  if (status !== 0) process.exit(status ?? 1);
}

run(root, "build:packages"); // Checks workspace links first, so a stale install stops here.
run(root, "build:backend");
run(join(root, "web"), "build");
