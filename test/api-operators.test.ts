import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthStatus, EventActor, InviteCheck, InviteSummary, OperatorSummary } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { PUBLIC_ROUTES } from "../src/server/auth.js";
import { STREAM_RECHECK_MS } from "../src/server/routes/tasks.js";
import { NOTE, call, cookieFrom, openStream, within, type App, type Call } from "./support/api-client.js";

const HOST: EventActor = { kind: "host", name: "ahmed" };
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new password";
const DAY = 24 * 60 * 60_000;
const EXPIRED = { error: "This link has expired or was already used" };
const NOT_ADMIN = { error: "Only admins can manage operators" };
const LAST_ADMIN = { error: "Keep at least one admin" };
const SIGN_IN_FIRST = { error: "Sign in to continue", signIn: true };

/** Every operators route only an admin may use. Each answers 403 for anyone else; see the first test. */
const ADMIN_ROUTES = [
  "GET /api/operators/invites",
  "POST /api/operators/invites",
  "DELETE /api/operators/invites/:id",
  "POST /api/operators/:id/role",
  "POST /api/operators/:id/reset",
  "POST /api/operators/:id/sign-out",
  "DELETE /api/operators/:id",
];
/** The operators routes any signed-in operator may use. */
const OPERATOR_ROUTES = ["GET /api/operators"];

type Issued = { invite: InviteSummary; token: string; path: string };

/**
 * An in-memory factory whose clock the test moves, with the admin Sam and the operator Lee, both added on the host.
 * Every log line is kept, so tests can check no token reaches it.
 */
async function setup() {
  const store = new Store(":memory:");
  const clock = { now: Date.parse("2026-11-01T12:00:00.000Z") };
  const now = () => clock.now;
  const log: string[] = [];
  const actions = new OperatorActions(store, now);
  const add = (username: string, name: string, role: string) => actions.addOperator(HOST, { username, name, role, password: PASSWORD });
  const sam = await add("sam", "Sam", "admin");
  const lee = await add("lee", "Lee", "operator");
  const app = createApp(store, { clock: now, log: (line) => log.push(line), clientKey: (c) => c.req.header("x-client") ?? "unknown" });
  return { store, clock, log, actions, add, sam, lee, app };
}

async function signedIn(app: App, username: string, password = PASSWORD): Promise<string> {
  const res = await call(app, "POST", "/api/auth/sign-in", { body: { username, password } });
  assert.equal(res.status, 200, await res.clone().text());
  return cookieFrom(res);
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const answered = await res;
  const body = await answered.json() as T;
  assert.equal(answered.status, status, JSON.stringify(body));
  return body;
}

const invite = (app: App, cookie: string, body: unknown = { role: "operator" }) =>
  json<Issued>(call(app, "POST", "/api/operators/invites", { cookie, body }));
const check = (app: App, token: unknown, opts: Call = {}) => call(app, "POST", "/api/auth/invites/check", { ...opts, body: { token } });
const accept = (app: App, body: Record<string, unknown>, opts: Call = {}) => call(app, "POST", "/api/auth/invites/accept", { ...opts, body });
const status = async (app: App, cookie: string) => (await call(app, "GET", "/api/tasks", { cookie })).status;

test("operators: every admin route answers 403 for a signed-in operator, and changes nothing", async () => {
  const { store, actions, add, app } = await setup();
  try {
    // The constants cover every operators route, so a new one has to say who may use it.
    const table = app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(table.filter((r) => r.includes(" /api/operators")).sort(), [...ADMIN_ROUTES, ...OPERATOR_ROUTES].sort());
    for (const route of ADMIN_ROUTES) assert.ok(!PUBLIC_ROUTES.includes(route), route);

    // Real targets, so a route that ran would change something instead of answering 400.
    const kim = await add("kim", "Kim", "operator");
    const pending = actions.inviteOperator(HOST, { role: "admin" }).invite;
    // Who exists with which role, and which links are pending; signing in only changes when each was last seen.
    const snapshot = () => ({
      operators: actions.listOperators().map(({ id, username, name, role }) => ({ id, username, name, role })),
      invites: actions.listInvites(HOST),
      events: store.eventsSince(0),
    });
    const before = snapshot();
    const lee = await signedIn(app, "lee");
    const kimCookie = await signedIn(app, "kim");
    for (const route of ADMIN_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      const target = path.replace(":id", path.includes("/invites/") ? pending.id : kim.id);
      const res = await call(app, method, target, { cookie: lee, body: { role: "admin", name: "Lee's friend" } });
      assert.equal(res.status, 403, route);
      assert.deepEqual(await res.json(), NOT_ADMIN, route);
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(await status(app, kimCookie), 200, "Kim is still signed in");

    // Any operator sees who else can sign in, and never a password hash.
    const listed = await json<OperatorSummary[]>(call(app, "GET", "/api/operators", { cookie: lee }));
    assert.deepEqual(listed.map((o) => [o.username, o.role]).sort(), [["kim", "operator"], ["lee", "operator"], ["sam", "admin"]]);
    assert.ok(listed.every((o) => !("passwordHash" in o)));
  } finally { store.close(); }
});

test("operators: an admin invites, and an anonymous client checks and accepts the link and is signed in", async () => {
  const { store, log, app } = await setup();
  try {
    const sam = await signedIn(app, "sam");
    const issued = await invite(app, sam, { role: "operator", name: "Kim" });
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.path, `/join#${issued.token}`);
    assert.deepEqual([issued.invite.kind, issued.invite.role, issued.invite.name, issued.invite.invitedBy], ["join", "operator", "Kim", "Sam"]);
    assert.deepEqual((await json<InviteSummary[]>(call(app, "GET", "/api/operators/invites", { cookie: sam }))).map((i) => i.id), [issued.invite.id]);

    const checked = await json<InviteCheck>(check(app, issued.token));
    assert.deepEqual(checked, { kind: "join", role: "operator", name: "Kim", username: null, invitedBy: "Sam", expiresAt: issued.invite.expiresAt });

    // The new operator's browser may hold someone else's session; accepting replaces it, as signing in does.
    const earlier = await signedIn(app, "lee");
    const res = await accept(app, { token: issued.token, username: "Kim", name: "Kim Park", password: PASSWORD }, { cookie: earlier });
    const joined = await json<AuthStatus>(res);
    assert.deepEqual([joined.signedIn, joined.operator?.username, joined.operator?.name, joined.operator?.role], [true, "kim", "Kim Park", "operator"]);
    const cookie = cookieFrom(res);
    assert.ok(res.headers.get("set-cookie")!.split("; ").includes("HttpOnly"));
    assert.equal((await call(app, "GET", "/api/overview", { cookie })).status, 200);
    assert.equal(await status(app, earlier), 401);
    assert.equal((await call(app, "POST", "/api/auth/sign-in", { body: { username: "kim", password: PASSWORD } })).status, 200);

    // It works once.
    assert.deepEqual(await json(check(app, issued.token), 401), EXPIRED);
    assert.deepEqual(await json(accept(app, { token: issued.token, username: "kim2", name: "Kim", password: PASSWORD }), 401), EXPIRED);
    assert.deepEqual(await json(call(app, "GET", "/api/operators/invites", { cookie: sam })), []);
    assert.ok(log.includes("Signed in kim with a link from unknown"));
    assert.ok(log.every((line) => !line.includes(issued.token)));
    assert.ok(!JSON.stringify(store.eventsSince(0)).includes(issued.token));
  } finally { store.close(); }
});

test("operators: an expired or revoked link answers 401, and a taken username a clear 400 that doesn't use the link", async () => {
  const { store, clock, app } = await setup();
  try {
    const sam = await signedIn(app, "sam");
    const expiring = await invite(app, sam);
    clock.now += 7 * DAY;
    assert.deepEqual(await json(check(app, expiring.token), 401), EXPIRED);
    assert.deepEqual(await json(accept(app, { token: expiring.token, username: "kim", name: "Kim", password: PASSWORD }), 401), EXPIRED);

    const sam2 = await signedIn(app, "sam");
    const revoked = await invite(app, sam2);
    assert.deepEqual(await json(call(app, "DELETE", `/api/operators/invites/${revoked.invite.id}`, { cookie: sam2 })), []);
    assert.deepEqual(await json(accept(app, { token: revoked.token, username: "kim", name: "Kim", password: PASSWORD }), 401), EXPIRED);
    assert.deepEqual(await json(call(app, "DELETE", `/api/operators/invites/${revoked.invite.id}`, { cookie: sam2 }), 400),
      { error: `No pending link ${revoked.invite.id}` });

    // Bad input isn't a guess: these don't count toward the limit, and the link still works afterwards.
    const issued = await invite(app, sam2);
    for (let i = 0; i < 6; i++) {
      const taken = await accept(app, { token: issued.token, username: "SAM", name: "Sam", password: PASSWORD });
      assert.deepEqual(await json(taken, 400), { error: "That username is taken" });
    }
    assert.deepEqual(await json(accept(app, { token: issued.token, username: "kim", name: "Kim", password: "short" }), 400),
      { error: "Choose a password of at least 12 characters" });
    assert.equal((await accept(app, { token: issued.token, username: "kim", name: "Kim", password: PASSWORD })).status, 200);
  } finally { store.close(); }
});

test("operators: a reset link sets the new password and signs out the operator's earlier cookies", async () => {
  const { store, lee, app } = await setup();
  try {
    const sam = await signedIn(app, "sam");
    const laptop = await signedIn(app, "lee");
    const phone = await signedIn(app, "lee");
    const reset = await json<Issued>(call(app, "POST", `/api/operators/${lee.id}/reset`, { cookie: sam }));
    assert.equal(reset.path, `/join#${reset.token}`);
    assert.deepEqual([reset.invite.kind, reset.invite.forOperator?.username], ["reset", "lee"]);
    const checked = await json<InviteCheck>(check(app, reset.token));
    assert.deepEqual([checked.kind, checked.username, checked.name], ["reset", "lee", "Lee"]);

    // Lee is still signed in until the link is used.
    assert.deepEqual([await status(app, laptop), await status(app, phone)], [200, 200]);
    const res = await accept(app, { token: reset.token, username: "ignored", password: NEW_PASSWORD });
    const signed = await json<AuthStatus>(res);
    assert.deepEqual([signed.signedIn, signed.operator?.id], [true, lee.id]);
    assert.deepEqual([await status(app, laptop), await status(app, phone), await status(app, cookieFrom(res))], [401, 401, 200]);
    assert.equal((await call(app, "POST", "/api/auth/sign-in", { body: { username: "lee", password: PASSWORD } })).status, 401);
    await signedIn(app, "lee", NEW_PASSWORD);
    assert.equal((await accept(app, { token: reset.token, password: "yet another password" })).status, 401);
  } finally { store.close(); }
});

test("operators: the last admin can't be demoted or removed, and a demoted admin loses admin routes at once", async () => {
  const { store, sam, lee, app } = await setup();
  try {
    const cookie = await signedIn(app, "sam");
    assert.deepEqual(await json(call(app, "POST", `/api/operators/${sam.id}/role`, { cookie, body: { role: "operator" } }), 400), LAST_ADMIN);
    assert.deepEqual(await json(call(app, "DELETE", `/api/operators/${sam.id}`, { cookie }), 400), LAST_ADMIN);
    assert.deepEqual(await json(call(app, "POST", `/api/operators/${sam.id}/role`, { cookie, body: { role: "owner" } }), 400),
      { error: "Choose the role admin or operator" });

    const promoted = await json<OperatorSummary[]>(call(app, "POST", `/api/operators/${lee.id}/role`, { cookie, body: { role: "admin" } }));
    assert.equal(promoted.find((o) => o.id === lee.id)?.role, "admin");
    // With two admins, Lee demotes Sam, and Sam's very next admin request is refused.
    const leeCookie = await signedIn(app, "lee");
    const demoted = await json<OperatorSummary[]>(call(app, "POST", `/api/operators/${sam.id}/role`, { cookie: leeCookie, body: { role: "operator" } }));
    assert.equal(demoted.find((o) => o.id === sam.id)?.role, "operator");
    assert.deepEqual(await json(call(app, "GET", "/api/operators/invites", { cookie }), 403), NOT_ADMIN);
    assert.deepEqual(await json(call(app, "DELETE", `/api/operators/${lee.id}`, { cookie: leeCookie }), 400), LAST_ADMIN);
  } finally { store.close(); }
});

test("operators: removing an operator, or signing them out, stops their cookies and ends their open streams", async () => {
  const { store, clock, lee, add, app } = await setup();
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const task = store.createTask({ kind: "maintenance", title: "Watch me", brief: "", repoId: null, autonomy: "propose" });
    store.addEvent(task.id, "note", NOTE);
    const sam = await signedIn(app, "sam");
    const leeCookie = await signedIn(app, "lee");
    const stream = await openStream(app, task.id, leeCookie);
    streams.push(stream.reader);

    const left = await json<OperatorSummary[]>(call(app, "DELETE", `/api/operators/${lee.id}`, { cookie: sam }));
    assert.deepEqual(left.map((o) => o.username), ["sam"]);
    assert.deepEqual(await json(call(app, "GET", "/api/tasks", { cookie: leeCookie }), 401), SIGN_IN_FIRST);
    assert.equal((await call(app, "POST", "/api/auth/sign-in", { body: { username: "lee", password: PASSWORD } })).status, 401);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(stream.ended, 3000), "ended");

    const kim = await add("kim", "Kim", "operator");
    const kimCookie = await signedIn(app, "kim");
    const kimStream = await openStream(app, task.id, kimCookie);
    streams.push(kimStream.reader);
    const after = await json<OperatorSummary[]>(call(app, "POST", `/api/operators/${kim.id}/sign-out`, { cookie: sam }));
    assert.equal(after.find((o) => o.id === kim.id)?.devices, 0);
    assert.equal(await status(app, kimCookie), 401);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(kimStream.ended, 3000), "ended");
    assert.equal(await status(app, sam), 200, "the admin stays signed in");
  } finally {
    for (const reader of streams) await reader.cancel().catch(() => {});
    store.close();
  }
});

test("operators: accepting from another origin is refused, without a cookie or using the link", async () => {
  const { store, app } = await setup();
  try {
    const { token } = await invite(app, await signedIn(app, "sam"));
    const body = { token, username: "kim", name: "Kim", password: PASSWORD };
    const forgeries: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of forgeries) {
      const res = await accept(app, body, { headers });
      assert.deepEqual(await json(res, 403), { error: "Cross-origin requests can't change anything" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal((await accept(app, body, { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } })).status, 200);
  } finally { store.close(); }
});

test("operators: repeated bad tokens wait with 429, per client and overall, apart from sign-in", async () => {
  const { store, clock, log, app } = await setup();
  try {
    const { token } = await invite(app, await signedIn(app, "sam"));
    for (let i = 0; i < 5; i++) assert.deepEqual(await json(check(app, `guess-${i}`), 401), EXPIRED);
    // Refused before the token is looked at, even a good one.
    const refused = await check(app, token);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.deepEqual(await json(refused, 429), { error: "Too many failed attempts. Try again in 30 seconds.", retryAfterSeconds: 30 });
    assert.equal((await accept(app, { token, username: "kim", name: "Kim", password: PASSWORD })).status, 429, "accepting waits too");
    assert.equal((await check(app, token, { client: "10.0.0.2" })).status, 200, "another client doesn't wait");
    assert.equal((await call(app, "POST", "/api/auth/sign-in", { body: { username: "lee", password: PASSWORD } })).status, 200,
      "guessing links doesn't use up sign-in attempts");
    clock.now += 30_000;
    assert.equal((await check(app, token)).status, 200);

    // Bad accepts count as well, and thirty failures in all make everyone wait.
    for (let i = 0; i < 5; i++) assert.equal((await accept(app, { token: `guess-${i}` }, { client: "10.0.1.1" })).status, 401);
    assert.equal((await accept(app, { token }, { client: "10.0.1.1" })).status, 429);
    for (let i = 0; i < 20; i++) assert.equal((await check(app, `guess-${i}`, { client: `10.0.2.${i}` })).status, 401);
    const everyone = await check(app, token, { client: "10.0.3.1" });
    assert.equal(everyone.status, 429);
    assert.equal(everyone.headers.get("retry-after"), "30");

    assert.equal(log.filter((line) => line === "Link check failed from unknown").length, 5);
    assert.ok(log.includes("Link accept failed from 10.0.1.1"));
    assert.ok(log.every((line) => !line.includes("guess-") && !line.includes(token)));
  } finally { store.close(); }
});

test("operators: tokens never go in a path or query string", async () => {
  const { store, app } = await setup();
  try {
    const table = app.routes.map((r) => r.path);
    assert.ok(table.every((path) => !/token/i.test(path)), "no route takes a token in its path");
    // A token in a query string is ignored, not read: the link counts as missing.
    const { token } = await invite(app, await signedIn(app, "sam"));
    const res = await app.request(`/api/auth/invites/check?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.deepEqual([res.status, await res.json()], [401, EXPIRED]);
    assert.equal((await check(app, token)).status, 200);
  } finally { store.close(); }
});

test("operators: on loopback with no operators, managing them needs the host", async () => {
  const store = new Store(":memory:");
  try {
    const app = createApp(store);
    assert.deepEqual(await json(call(app, "GET", "/api/operators")), []);
    assert.deepEqual(await json(call(app, "POST", "/api/operators/invites", { body: { role: "admin" } }), 401), { error: "Sign in to continue" });
    assert.deepEqual(await json(check(app, "anything"), 401), EXPIRED);
  } finally { store.close(); }
});
