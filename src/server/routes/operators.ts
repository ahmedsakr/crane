import type { Context, Hono } from "hono";
import { describeClient, inviteLinkPath } from "@crane/contracts";
import { AccessError } from "@crane/factory/actions";
import type { IssuedInvite } from "@crane/factory/actions";
import { sessionToken, setSessionCookie, signedInActor } from "../auth.js";
import type { ApiAccess } from "../auth.js";
import { optionalJsonObject } from "../body.js";
import type { RouteDeps } from "./deps.js";

/**
 * Managing operators, and the public invite endpoints the join page uses. Every managing route passes the signed-in
 * operator as `by`, so the actions decide who is an admin; the routes never check roles themselves.
 *
 * Join and reset tokens travel only in request bodies and in the link's fragment, never in a path or query string,
 * and nothing here logs one.
 */

/** A new link, with the path that opens it: `/join#<token>`. */
const withPath = (issued: IssuedInvite) => ({ ...issued, path: inviteLinkPath(issued.token) });

/** Only a link that isn't valid counts as a guess; a short password or a taken username doesn't. */
const badLink = (err: unknown) => err instanceof AccessError && err.status === 401;

/** The client as a log line shows it: the limiter's printable key. */
const clientName = (access: ApiAccess, c: Context) => access.limiter.limit("client", access.clientKey(c)).key;

/**
 * Check or use a link under per-client and overall limits of their own, so guessing tokens can't use up anyone's
 * sign-in attempts. Logs failures by client, never the token; refusals while waiting aren't logged.
 */
async function limitedLink<T>(access: ApiAccess, c: Context, what: "check" | "accept", fn: () => Promise<T>): Promise<T> {
  const { limiter } = access;
  const client = limiter.limit("client", `link ${access.clientKey(c)}`);
  try {
    return await limiter.attempt([client, limiter.limit("global", "links")], fn, badLink);
  } catch (err) {
    if (badLink(err)) access.log(`Link ${what} failed from ${clientName(access, c)}`);
    throw err;
  }
}

type AcceptBody = { token?: unknown; username?: unknown; name?: unknown; password?: unknown };

/** Public: see `PUBLIC_ROUTES`. Accepting signs this device in, like signing in does. */
function registerLinkRoutes(api: Hono, { actions, access }: RouteDeps): void {
  api.post("/auth/invites/check", async (c) => {
    const { token } = await optionalJsonObject<{ token?: unknown }>(c.req.raw);
    return c.json(await limitedLink(access, c, "check", async () => actions.checkInvite(token)));
  });
  api.post("/auth/invites/accept", async (c) => {
    const { token, username, name, password } = await optionalJsonObject<AcceptBody>(c.req.raw);
    const previous = sessionToken(c);
    const client = describeClient(c.req.header("user-agent"));
    const signed = await limitedLink(access, c, "accept", () => actions.acceptInvite(token, { username, name, password }, { client }));
    access.log(`Signed in ${signed.operator.username} with a link from ${clientName(access, c)}`);
    // The device's old session would otherwise stay signed in, unseen, until it expired.
    if (previous) actions.signOut(previous);
    setSessionCookie(c, signed.token);
    return c.json(actions.authStatus(signed.token, { exposed: access.exposed }));
  });
}

/** Join and reset links not used yet. Admin only. */
function registerInviteRoutes(api: Hono, { actions }: RouteDeps): void {
  api.get("/operators/invites", (c) => c.json(actions.listInvites(signedInActor(c))));
  api.post("/operators/invites", async (c) => {
    const { role, name } = await optionalJsonObject<{ role?: unknown; name?: unknown }>(c.req.raw);
    return c.json(withPath(actions.inviteOperator(signedInActor(c), { role, name })));
  });
  api.delete("/operators/invites/:id", (c) => {
    const by = signedInActor(c);
    actions.revokeInvite(by, c.req.param("id"));
    return c.json(actions.listInvites(by));
  });
}

/** The operator list for anyone signed in; changing an operator is admin only. Changes answer with the new list. */
function registerOperatorRoutes(api: Hono, { actions }: RouteDeps): void {
  api.get("/operators", (c) => c.json(actions.listOperators()));
  api.post("/operators/:id/role", async (c) => {
    const { role } = await optionalJsonObject<{ role?: unknown }>(c.req.raw);
    actions.setOperatorRole(signedInActor(c), c.req.param("id"), role);
    return c.json(actions.listOperators());
  });
  api.post("/operators/:id/reset", (c) => c.json(withPath(actions.createPasswordReset(signedInActor(c), c.req.param("id")))));
  api.post("/operators/:id/sign-out", (c) => {
    actions.signOutOperator(signedInActor(c), c.req.param("id"));
    return c.json(actions.listOperators());
  });
  api.delete("/operators/:id", (c) => {
    actions.removeOperator(signedInActor(c), c.req.param("id"));
    return c.json(actions.listOperators());
  });
}

export function registerOperatorsRoutes(api: Hono, deps: RouteDeps): void {
  registerLinkRoutes(api, deps);
  registerInviteRoutes(api, deps);
  registerOperatorRoutes(api, deps);
}
