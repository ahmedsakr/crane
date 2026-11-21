import type { Context, Hono } from "hono";
import { describeClient, normalizeUsername } from "@crane/contracts";
import { WRONG_CURRENT_PASSWORD } from "@crane/factory/actions";
import { clearSessionCookie, sessionToken, setSessionCookie } from "../auth.js";
import type { ApiAccess } from "../auth.js";
import { optionalJsonObject } from "../body.js";
import { TooManyAttempts } from "../sign-in-limit.js";
import type { RouteDeps } from "./deps.js";

type Credentials = { username?: unknown; password?: unknown };

/**
 * Sign in under the client, username and overall limits. The overall limit doesn't hold back a username with no
 * recent failures and no attempt in flight, so a spray of guesses can't lock out an operator nobody is guessing;
 * each such username gets one try at a time. Logs who and from where, never the password.
 */
async function limitedSignIn(access: ApiAccess, c: Context, { username, password }: Credentials) {
  const { limiter } = access;
  const client = limiter.limit("client", access.clientKey(c));
  const name = limiter.limit("username", typeof username === "string" ? normalizeUsername(username) : "");
  try {
    const signed = await limiter.attempt([client, name, limiter.limit("global", "sign-in", name)], () =>
      access.actions.signIn(username, password, { client: describeClient(c.req.header("user-agent")) }));
    access.log(`Signed in ${signed.operator.username} from ${client.key}`);
    return signed;
  } catch (err) {
    // Refused attempts aren't logged, so a flood of them can't flood the log.
    if (!(err instanceof TooManyAttempts)) access.log(`Sign-in failed for ${JSON.stringify(name.key)} from ${client.key}`);
    throw err;
  }
}

/** A stolen session mustn't be a way to guess the password it was signed in with, so wrong guesses count too. */
async function limitedPasswordChange(access: ApiAccess, c: Context, current: unknown, next: unknown) {
  const { limiter } = access;
  const client = limiter.limit("client", access.clientKey(c));
  const name = limiter.limit("username", c.get("auth")?.operator.username ?? "");
  const wrong = (err: unknown) => err instanceof Error && err.message === WRONG_CURRENT_PASSWORD;
  try {
    await limiter.attempt([client, name], () => access.actions.changeMyPassword(sessionToken(c), current, next), wrong);
  } catch (err) {
    if (wrong(err)) access.log(`Password change failed for ${JSON.stringify(name.key)} from ${client.key}: wrong current password`);
    throw err;
  }
}

/** Session status, signing in and signing out. Status and sign-in are public; see `PUBLIC_ROUTES`. */
function registerSignInRoutes(api: Hono, { actions, access }: RouteDeps): void {
  const status = (token: string | undefined) => actions.authStatus(token, { exposed: access.exposed });
  api.get("/auth/session", (c) => c.json(status(sessionToken(c))));
  api.post("/auth/sign-in", async (c) => {
    const credentials = await optionalJsonObject<Credentials>(c.req.raw);
    const previous = sessionToken(c);
    const signed = await limitedSignIn(access, c, credentials);
    // The device's old session would otherwise stay signed in, unseen, until it expired.
    if (previous) actions.signOut(previous);
    setSessionCookie(c, signed.token);
    return c.json(status(signed.token));
  });
  api.post("/auth/sign-out", (c) => {
    actions.signOut(sessionToken(c));
    clearSessionCookie(c);
    return c.json(status(undefined));
  });
}

/** The signed-in operator's own devices, password and name. */
function registerAccountRoutes(api: Hono, { actions, access }: RouteDeps): void {
  api.get("/auth/me/sessions", (c) => c.json(actions.listMySessions(sessionToken(c))));
  api.delete("/auth/me/sessions/:id", (c) => {
    const token = sessionToken(c);
    const id = c.req.param("id");
    actions.signOutMySession(token, id);
    if (c.get("auth")?.session.id !== id) return c.json(actions.listMySessions(token));
    // This device signed itself out.
    clearSessionCookie(c);
    return c.json([]);
  });
  api.post("/auth/me/sessions/sign-out-others", (c) => {
    const token = sessionToken(c);
    actions.signOutMyOtherSessions(token);
    return c.json(actions.listMySessions(token));
  });
  api.post("/auth/me/password", async (c) => {
    const { current, next } = await optionalJsonObject<{ current?: unknown; next?: unknown }>(c.req.raw);
    await limitedPasswordChange(access, c, current, next);
    return c.json({ ok: true });
  });
  api.post("/auth/me/name", async (c) => {
    const { name } = await optionalJsonObject<{ name?: unknown }>(c.req.raw);
    return c.json(actions.renameMe(sessionToken(c), name));
  });
}

export function registerAuthRoutes(api: Hono, deps: RouteDeps): void {
  registerSignInRoutes(api, deps);
  registerAccountRoutes(api, deps);
}
