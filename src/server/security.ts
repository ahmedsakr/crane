import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for methods that only read, so they can't change anything. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method);
}

/** True for addresses only this machine can reach. `crane serve` binds one of these unless told to expose the dashboard. */
export function isLoopbackAddress(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host) || host === "::1";
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // "null" and other opaque origins.
  }
}

/**
 * Why a request must not reach the API, or null if it may.
 * - A Host that isn't loopback means DNS rebinding (or a LAN client when we're bound to loopback), unless the
 *   operator exposed the dashboard on purpose.
 * - A mutating request from another origin is a page in the operator's browser forging a decision. Browsers send
 *   such `text/plain` POSTs without a preflight, so the API checks Origin and Sec-Fetch-Site itself. Clients that
 *   send neither (curl, scripts) aren't browsers and are let through.
 */
export function refusal(request: Request, exposed: boolean): string | null {
  const url = new URL(request.url);
  if (!exposed && !LOOPBACK_HOSTNAMES.has(url.hostname)) return "This dashboard only answers on localhost";
  if (SAFE_METHODS.has(request.method)) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-origin requests can't change anything";
  const origin = request.headers.get("origin");
  if (origin !== null && hostOf(origin) !== url.host) return "Cross-origin requests can't change anything";
  return null;
}

/** Answers 403 for any request `refusal` turns away. Registered before every route and the static fallback. */
export function refuseUntrusted(exposed: boolean): MiddlewareHandler {
  return async (c, next) => {
    const reason = refusal(c.req.raw, exposed);
    if (reason) return c.json({ error: reason }, 403);
    await next();
  };
}
