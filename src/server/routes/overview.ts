import type { Hono, MiddlewareHandler } from "hono";
import { isSafeMethod } from "../security.js";
import type { RouteDeps } from "./deps.js";

/** How long open tabs share one overview, each polling it every 2 s on the thread that runs the factory. */
const OVERVIEW_SHARED_MS = 1000;

/**
 * One overview shared by every open tab for up to a second. `invalidate` must wrap every API route, so an
 * action's result shows on the next poll.
 */
export function overviewCache() {
  let shared: { at: number; json: string } | null = null;
  const invalidate: MiddlewareHandler = async (c, next) => {
    // Cleared once the action finishes, in case a poll saw it halfway.
    try {
      await next();
    } finally {
      if (!isSafeMethod(c.req.method)) shared = null;
    }
  };
  const read = (build: () => unknown): string => {
    const at = performance.now();
    if (!shared || at - shared.at >= OVERVIEW_SHARED_MS) shared = { at, json: JSON.stringify(build()) };
    return shared.json;
  };
  return { invalidate, read };
}

export type OverviewCache = ReturnType<typeof overviewCache>;

/** The factory-wide reads the home and analytics pages poll. */
export function registerOverviewRoutes(api: Hono, { store, factoryState }: RouteDeps, cache: OverviewCache): void {
  api.get("/overview", (c) => {
    const json = cache.read(() => store.overview(factoryState()));
    return c.body(json, 200, { "content-type": "application/json" });
  });
  api.get("/analytics", (c) => c.json(store.analytics(Number(c.req.query("days") ?? 30))));
}
