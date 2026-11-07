import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIPv4 } from "node:net";

declare module "hono" {
  interface ContextVariableMap {
    /** Whether the browser reached this request over HTTPS, as `secureResponses` worked out. */
    https: boolean | undefined;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HSTS = "max-age=31536000";

/** How the dashboard is reached, as `crane serve` was told. */
export interface Exposure {
  /** Listening beyond loopback, or reached through a public URL. */
  exposed: boolean;
  /** The origin operators browse to (`--public-url`), or null. */
  publicUrl: URL | null;
  /** Honour X-Forwarded-Proto and X-Forwarded-For, from a proxy on this machine only (`--trust-proxy`). */
  trustProxy: boolean;
}

/** True for methods that only read, so they can't change anything. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method);
}

/** True for addresses only this machine can reach. `crane serve` binds one of these unless told to expose the dashboard. */
export function isLoopbackAddress(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host) || host === "::1";
}

/**
 * The origin `--public-url` names, such as `https://crane.example.com`. Refuses anything but an http or https
 * origin: no path, query, fragment or credentials, since Crane is served from the root of its address.
 */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--public-url takes the address operators browse to, such as https://crane.example.com, not ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`--public-url must start with https:// (or http://), not ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("--public-url can't contain a username or password");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`--public-url is an origin without a path. Crane is served from the root: ${url.origin}`);
  }
  return new URL(url.origin);
}

/** What `crane serve`'s address options mean, and whether it may start with them. */
export interface ExposureCheck {
  exposed: boolean;
  publicUrl: URL | null;
  /** Why serving must not start. */
  error?: string;
  /** What the operator chose to accept, said at start. */
  warning?: string;
}

export interface ServeAddress {
  host: string;
  publicUrl?: string;
  allowInsecureHttp?: boolean;
  /** How many operators can sign in. */
  operators: number;
}

/**
 * Exposed means listening beyond loopback or reached through a public URL. An exposed factory needs an operator to
 * sign in as, and HTTPS in front of it, or passwords and session cookies cross the network in plain text.
 */
export function checkExposure(address: ServeAddress): ExposureCheck {
  let publicUrl: URL | null;
  try {
    publicUrl = address.publicUrl === undefined ? null : parsePublicUrl(address.publicUrl);
  } catch (err) {
    return { exposed: true, publicUrl: null, error: (err as Error).message };
  }
  const exposed = publicUrl !== null || !isLoopbackAddress(address.host);
  if (!exposed) return { exposed, publicUrl };
  if (address.operators === 0) {
    return {
      exposed, publicUrl,
      error: "Nobody can sign in yet, so an exposed factory would refuse every request. On the host, run crane operators add <username> --admin, then start it again.",
    };
  }
  if (publicUrl?.protocol === "https:") return { exposed, publicUrl };
  const plain = `Exposed without an https --public-url, passwords and session cookies would cross the network unencrypted.`;
  if (!address.allowInsecureHttp) {
    return { exposed, publicUrl, error: `${plain} Put Crane behind HTTPS and pass --public-url https://<domain>, or pass --allow-insecure-http on a network you trust.` };
  }
  return { exposed, publicUrl, warning: `${plain} Serving anyway, because of --allow-insecure-http.` };
}

function originOf(origin: string): URL | null {
  try {
    return new URL(origin);
  } catch {
    return null; // "null" and other opaque origins.
  }
}

/** With a public URL, only it and loopback answer; without one, loopback, or anything once exposed on purpose. */
function hostAllowed(url: URL, { exposed, publicUrl }: Pick<Exposure, "exposed" | "publicUrl">): boolean {
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return true;
  if (publicUrl) return url.host === publicUrl.host;
  return exposed;
}

/** The public origin exactly, or the request's own host. With a public URL, only a loopback host counts as its own. */
function sameOrigin(origin: string, url: URL, publicUrl: URL | null): boolean {
  if (publicUrl && origin === publicUrl.origin) return true;
  const from = originOf(origin);
  if (!from || from.host !== url.host) return false;
  return !publicUrl || LOOPBACK_HOSTNAMES.has(from.hostname);
}

/**
 * Why a request must not reach the API, or null if it may.
 * - A Host that isn't loopback means DNS rebinding (or a LAN client when we're bound to loopback), unless the
 *   operator exposed the dashboard on purpose. With a public URL, its host is the only other one answered, which
 *   also lets a reverse proxy that keeps the public Host reach a factory bound to 127.0.0.1.
 * - A mutating request from another origin is a page in the operator's browser forging a decision. Browsers send
 *   such `text/plain` POSTs without a preflight, so the API checks Origin and Sec-Fetch-Site itself. Clients that
 *   send neither (curl, scripts) aren't browsers and are let through.
 */
export function refusal(request: Request, exposure: Pick<Exposure, "exposed" | "publicUrl">): string | null {
  const url = new URL(request.url);
  if (!hostAllowed(url, exposure)) {
    return exposure.publicUrl ? `This dashboard only answers at ${exposure.publicUrl.origin} and on localhost` : "This dashboard only answers on localhost";
  }
  if (SAFE_METHODS.has(request.method)) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "Cross-origin requests can't change anything";
  const origin = request.headers.get("origin");
  if (origin !== null && !sameOrigin(origin, url, exposure.publicUrl)) return "Cross-origin requests can't change anything";
  return null;
}

/** Answers 403 for any request `refusal` turns away. Registered before every route and the static fallback. */
export function refuseUntrusted(exposure: Pick<Exposure, "exposed" | "publicUrl">): MiddlewareHandler {
  return async (c, next) => {
    const reason = refusal(c.req.raw, exposure);
    if (reason) return c.json({ error: reason }, 403);
    await next();
  };
}

/** The address of the socket a request came in on, or null when there is none, as under `app.request()`. */
export function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** A peer on this machine: 127.0.0.0/8 or ::1, including IPv4 mapped into IPv6. */
export function isLoopbackPeer(address: string | null): boolean {
  if (!address) return false;
  const v4 = address.replace(/^::ffff:/i, "");
  if (isIPv4(v4)) return v4.startsWith("127.");
  return address === "::1";
}

/**
 * The value a trusted proxy on this machine forwarded in `name`, or null. Only with `--trust-proxy` and a loopback
 * peer: anyone else could claim any address or scheme. The last hop is the one the proxy itself added; earlier ones
 * came from the client.
 */
export function forwardedValue(c: Context, trustProxy: boolean, name: string): string | null {
  if (!trustProxy || !isLoopbackPeer(peerAddress(c))) return null;
  const hops = (c.req.header(name) ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) ?? null;
}

/**
 * Whether the browser reached this request over HTTPS: what a trusted proxy says, else the public URL's scheme for
 * requests to its host, else the request's own.
 */
export function requestIsHttps(c: Context, exposure: Pick<Exposure, "publicUrl" | "trustProxy">): boolean {
  const proto = forwardedValue(c, exposure.trustProxy, "x-forwarded-proto");
  if (proto) return proto.toLowerCase() === "https";
  const url = new URL(c.req.url);
  if (exposure.publicUrl && url.host === exposure.publicUrl.host) return exposure.publicUrl.protocol === "https:";
  return url.protocol === "https:";
}

/** `policy` with `frame-ancestors 'none'` in place of any frame-ancestors it had, so merging never weakens it. */
export function withFrameAncestors(policy: string | null): string {
  const kept = (policy ?? "").split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return [...kept, "frame-ancestors 'none'"].join("; ");
}

/**
 * Registered first, so every response carries these, refusals, the API, the web app and its assets alike: no
 * framing by other sites, no referrer beyond this origin, no type sniffing, and HSTS once the browser is on HTTPS.
 * Also records the request's scheme for the session cookie's Secure flag.
 */
export function secureResponses(exposure: Pick<Exposure, "publicUrl" | "trustProxy">): MiddlewareHandler {
  return async (c, next) => {
    const https = requestIsHttps(c, exposure);
    c.set("https", https);
    await next();
    const headers = c.res.headers;
    headers.set("x-frame-options", "DENY");
    headers.set("content-security-policy", withFrameAncestors(headers.get("content-security-policy")));
    headers.set("referrer-policy", "same-origin");
    headers.set("x-content-type-options", "nosniff");
    if (https) headers.set("strict-transport-security", HSTS);
  };
}
