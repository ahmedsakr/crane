import type { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { servedDashboard } from "../application.js";

/**
 * The file a request path names in the first of `dirs` that has it. Only
 * files inside those directories, never `index.html` (pages are handled apart).
 * Older builds come after the served one, so a page that's still open from
 * before a new build can finish loading its assets.
 */
export function staticFile(path: string, dirs: string[]): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (rel === "/" || rel.endsWith("/") || rel === "/index.html" || rel.includes("\0")) return null;
  for (const dir of dirs) {
    const file = resolve(dir, `.${rel}`);
    if (!file.startsWith(dir + sep)) continue;
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Not in this build.
    }
  }
  return null;
}

/**
 * Serve the newest built web app: Crane's own build of the latest merge, or
 * the checkout's web/dist. Chosen per request, so a new build is picked up
 * without restarting the factory. Register after the API so it only catches the rest.
 */
export function registerDashboard(app: Hono): void {
  app.get("*", (c) => {
    const served = servedDashboard();
    if (!served) {
      return c.text("Crane's API is running. Build the web app with `npm run build`, or run `npm run dev` for the live UI on :5173.");
    }
    const file = staticFile(c.req.path, [served.dir, ...served.fallbacks]);
    if (file) {
      return c.body(readFileSync(file), 200, {
        "content-type": getMimeType(file) ?? "application/octet-stream",
        // Bundles are named by their content, so they never change.
        ...(c.req.path.startsWith("/assets/") ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
      });
    }
    if (c.req.path.startsWith("/assets/")) return c.text("Not found", 404);
    // Everything else is a page of the app. Never cached, so a reload gets the newest build.
    return c.html(readFileSync(join(served.dir, "index.html"), "utf8"), 200, { "cache-control": "no-cache" });
  });
}
