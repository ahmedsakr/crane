import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invalidWorkspaceLinks } from "./check-workspace-links.mjs";

/**
 * The execution environment Nx folds into every cached task's hash (`nx.json`'s
 * `toolchain` named input). The lockfile says what should be installed; this
 * says what is: a stale `node_modules`, another Node release, platform or CPU
 * architecture, or a different installed compiler changes the hash, so a cached
 * result from one environment is never replayed in another.
 *
 * It reads manifests only and runs no tool, so it costs one Node start per run.
 */

/** Installed packages whose versions decide what a task produces. Vite lives under web/. */
export const TOOLS = /** @type {const} */ ([
  ["typescript", "node_modules/typescript"],
  ["esbuild", "node_modules/esbuild"],
  ["tsx", "node_modules/tsx"],
  ["nx", "node_modules/nx"],
  ["vite", "web/node_modules/vite"],
]);

/** @param {string} root @param {string} dir @returns {string} */
function installedVersion(root, dir) {
  try {
    const { version } = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "missing";
  }
}

/** Workspace packages whose `node_modules` link is wrong, so a broken install can't reuse a result.
 * @param {string} root @returns {string}
 */
function linkState(root) {
  try {
    const invalid = invalidWorkspaceLinks(root);
    return invalid.length ? `invalid: ${invalid.join(", ")}` : "ok";
  } catch (error) {
    return `unchecked: ${error instanceof Error ? error.message : error}`;
  }
}

/** @param {string} root @returns {Record<string, string>} */
export function toolchain(root) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...Object.fromEntries(TOOLS.map(([name, dir]) => [name, installedVersion(root, dir)])),
    workspaceLinks: linkState(root),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Resolve from this script, so the output does not depend on the shell's cwd.
  console.log(JSON.stringify(toolchain(fileURLToPath(new URL("../", import.meta.url)))));
}
