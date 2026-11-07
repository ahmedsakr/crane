import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { EventActor } from "@crane/contracts";
import { withActor } from "../core/actor.js";
import { AccessError, SESSION_LIFETIME_MS, SIGN_IN_FIRST, type Authenticated, type OperatorActions } from "../factory/actions.js";
import { parsePublicUrl, type Exposure } from "./security.js";
import { AttemptLimiter, TooManyAttempts, clientKeyFor, spellWait, type ClientKey, type Limit, type OnLimited } from "./sign-in-limit.js";

declare module "hono" {
  interface ContextVariableMap {
    /** The signed-in operator and device. Unset while sign-in isn't required, and on the public routes. */
    auth: Authenticated | undefined;
  }
}

export const SESSION_COOKIE = "crane_session";

/** The only API routes that answer without a session: what the sign-in and join pages need before there is one. */
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /api/auth/session",
  "POST /api/auth/sign-in",
  "POST /api/auth/invites/check",
  "POST /api/auth/invites/accept",
];
const PUBLIC = new Set(PUBLIC_ROUTES);

export const NOT_SET_UP = "Sign-in isn't set up. On the host, run crane operators add <username> --admin.";

export interface AccessOptions {
  /** Listening beyond loopback: every API call needs a session, even before any operator exists. */
  exposed?: boolean;
  /** The origin operators browse to (`crane serve --public-url`). Setting one also makes the app exposed. */
  publicUrl?: string;
  /** Honour X-Forwarded-Proto and X-Forwarded-For from a loopback peer (`crane serve --trust-proxy`). */
  trustProxy?: boolean;
  /** When the app thinks it is, for sessions, sign-in limits and stream re-checks. Tests move it. */
  clock?: () => number;
  /** Which client a request counts as for sign-in limits and logs. Defaults to the socket's address. */
  clientKey?: ClientKey;
  /** Where sign-in successes and failures are written. Never given a password. */
  log?: (line: string) => void;
}

/** What the gate and the sign-in routes share, built once per app by `createApp`. */
export interface ApiAccess extends Exposure {
  actions: OperatorActions;
  now: () => number;
  limiter: AttemptLimiter;
  clientKey: ClientKey;
  log: (line: string) => void;
}

export function apiAccess(actions: OperatorActions, opts: AccessOptions = {}): ApiAccess {
  const now = opts.clock ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const onLimited: OnLimited = (limit, waitMs) => {
    if (limit.kind === "global") log(overallLimitLine(limit, waitMs));
  };
  const publicUrl = opts.publicUrl === undefined ? null : parsePublicUrl(opts.publicUrl);
  const trustProxy = opts.trustProxy ?? false;
  return {
    actions,
    exposed: (opts.exposed ?? false) || publicUrl !== null,
    publicUrl,
    trustProxy,
    now,
    limiter: new AttemptLimiter(now, onLimited),
    clientKey: opts.clientKey ?? clientKeyFor(trustProxy),
    log,
  };
}

/**
 * What the log says when failures from every client together reach the overall limit, so the operator sees an
 * attack while it happens. One line per wait, not per refused attempt.
 */
export function overallLimitLine(limit: Limit, waitMs: number): string {
  const who = limit.unlessFresh ? "usernames with recent failures" : "every client";
  return `Too many failed ${limit.key} attempts from all clients: ${who} must wait ${spellWait(waitMs)}`;
}

/**
 * The session cookie's attributes: scripts can't read it, other sites' requests never carry it, and it lasts as
 * long as a session can. Secure when the browser is on HTTPS, which `secureResponses` works out from the public
 * URL or a trusted proxy.
 */
export function sessionCookieOptions(c: Context): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_LIFETIME_MS / 1000,
    secure: c.get("https") ?? new URL(c.req.url).protocol === "https:",
  };
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c));
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(c));
}

export type Admission = { ok: true; auth: Authenticated | null } | { ok: false; error: string };

/**
 * Whether a request may use the API now. Sign-in is required once any operator exists, and always when exposed;
 * `auth` is null only when it isn't. Read per request, so `crane operators add` takes effect without a restart.
 */
export function admit(access: ApiAccess, c: Context): Admission {
  const status = access.actions.authStatus(sessionToken(c), { exposed: access.exposed });
  if (!status.required) return { ok: true, auth: null };
  if (!status.setUp) return { ok: false, error: NOT_SET_UP };
  if (!status.operator || !status.session) return { ok: false, error: SIGN_IN_FIRST };
  return { ok: true, auth: { operator: status.operator, session: status.session } };
}

/**
 * The API's gate, registered before the overview cache and every route. A request without a valid session answers
 * 401 with `signIn: true`; one with a session runs the rest of the chain as its operator, so their events say who.
 */
export function requireSignIn(access: ApiAccess): MiddlewareHandler {
  return async (c, next) => {
    if (PUBLIC.has(`${c.req.method} ${c.req.path}`)) return next();
    const admission = admit(access, c);
    if (!admission.ok) return c.json({ error: admission.error, signIn: true }, 401);
    if (!admission.auth) return next();
    c.set("auth", admission.auth);
    return withActor(actorOf(admission.auth), next);
  };
}

const actorOf = ({ operator: { id, name } }: Authenticated): EventActor => ({ kind: "operator", id, name });

/**
 * Who a request acts as, for actions that decide what they may do, such as admin-only ones. Refuses with 401 when
 * nobody is signed in, which on loopback with no operators is every request: the host manages access with crane.
 */
export function signedInActor(c: Context): EventActor {
  const auth = c.get("auth");
  if (!auth) throw new AccessError(401, SIGN_IN_FIRST);
  return actorOf(auth);
}

/** Refusals about who is asking keep their status, with `Retry-After` when rate limited. Anything else is a 400. */
export function errorResponse(err: Error, c: Context): Response {
  if (err instanceof TooManyAttempts) {
    c.header("retry-after", String(err.retryAfterSeconds));
    return c.json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds }, 429);
  }
  if (err instanceof AccessError) return c.json({ error: err.message }, err.status);
  return c.json({ error: err.message }, 400);
}
