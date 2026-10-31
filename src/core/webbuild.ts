import { existsSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryRoot } from "./paths.js";

/** UI source the build depends on, relative to `web/`. */
const SOURCES = ["src", "index.html", "vite.config.ts", "package.json"];

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

const cache = new Map<string, { at: number; value: boolean }>();

/**
 * Whether the dashboard Crane serves (`web/dist`) is older than the UI source
 * next to it. That happens when a change to Crane's UI lands (say, an approved
 * factory feature) and nobody rebuilds: the fix is merged but the browser
 * still gets the old bundle. False when there's no build or no source to
 * compare (an installed package, say). Cached briefly since the UI polls.
 */
export function webBuildOutdated(root = factoryRoot(), now = Date.now()): boolean {
  const hit = cache.get(root);
  if (hit && now - hit.at < 5_000) return hit.value;
  const web = join(root, "web");
  const built = join(web, "dist", "index.html");
  let value = false;
  if (existsSync(built) && existsSync(join(web, "src"))) {
    const source = Math.max(...SOURCES.map((s) => newestMtime(join(web, s))));
    value = source > statSync(built).mtimeMs;
  }
  cache.set(root, { at: now, value });
  return value;
}

/**
 * Whether this process is running compiled code (`dist/`, which `bin/crane.js`
 * prefers) that's older than the TypeScript source beside it, so merged
 * changes to Crane aren't actually running.
 */
export function factoryBuildOutdated(root = factoryRoot()): boolean {
  if (!fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`)) return false;
  const built = join(root, "dist", "cli", "index.js");
  if (!existsSync(built) || !existsSync(join(root, "src"))) return false;
  return newestMtime(join(root, "src")) > statSync(built).mtimeMs;
}
