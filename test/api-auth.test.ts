import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { AuthStatus, EventActor, OperatorProfile, OperatorSession } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { currentActor } from "../src/core/actor.js";
import { AccessError, OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { NOT_SET_UP, PUBLIC_ROUTES, errorResponse } from "../src/server/auth.js";
import { STREAM_RECHECK_MS } from "../src/server/routes/tasks.js";
import { AttemptLimiter, FIRST_WAIT_MS, LIMIT_WINDOW_MS, MAX_WAIT_MS, TooManyAttempts } from "../src/server/sign-in-limit.js";
import { NOTE, call, cookieFrom, openStream, within, type App, type Call } from "./support/api-client.js";

const HOST: EventActor = { kind: "host", name: "ahmed" };
const PASSWORD = "correct horse battery";
const WRONG_PASSWORD = "not the right password";
const SIGN_IN_FIRST = { error: "Sign in to continue", signIn: true };
const WRONG = { error: "That username or password isn't right" };
const DAY = 24 * 60 * 60_000;

/**
 * An in-memory factory whose clock the test moves, with a task waiting for review and, unless `operators` is
 * false, the admin Sam. Clients name themselves with `x-client`, so one test can sign in from several.
 */
async function setup(opts: { exposed?: boolean; operators?: boolean } = {}) {
  const store = new Store(":memory:");
  const clock = { now: Date.parse("2026-11-01T12:00:00.000Z") };
  const now = () => clock.now;
  const log: string[] = [];
  const actions = new OperatorActions(store, now);
  const addSam = () => actions.addOperator(HOST, { username: "sam", name: "Sam", role: "admin", password: PASSWORD });
  const sam = opts.operators === false ? null : await addSam();
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "Review me", brief: "", repoId: repo.id, autonomy: "propose" });
  store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}`,
    visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
  const app = createApp(store, {
    exposed: opts.exposed, clock: now, log: (line) => log.push(line), clientKey: (c) => c.req.header("x-client") ?? "unknown",
  });
  return { store, clock, log, sam, addSam, task, app };
}

function signIn(app: App, opts: { username?: string; password?: string } & Call = {}) {
  const body = { username: opts.username ?? "sam", password: opts.password ?? PASSWORD };
  return call(app, "POST", "/api/auth/sign-in", { ...opts, body });
}

async function signedIn(app: App, opts: Parameters<typeof signIn>[1] = {}): Promise<string> {
  const res = await signIn(app, opts);
  assert.equal(res.status, 200, await res.clone().text());
  return cookieFrom(res);
}

const ids = (taskId: string): Record<string, string> => ({ id: taskId, taskId, name: "shot.png", key: "a", scheduleId: "s" });

/** Every route that needs a session, from the app's own route table, so a new route is covered once registered. */
function protectedRoutes(app: App, params: Record<string, string>): [string, string][] {
  return app.routes
    .filter((r) => r.method !== "ALL" && r.path !== "/*" && !PUBLIC_ROUTES.includes(`${r.method} ${r.path}`))
    .map((r) => [r.method, r.path.replace(/:(\w+)/g, (_, p: string) => params[p] ?? p)]);
}

/** Record who each event is written as. */
function spyActors(store: Store): (EventActor | null)[] {
  const actors: (EventActor | null)[] = [];
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (...args: Parameters<Store["addEvent"]>) => {
    actors.push(currentActor());
    return addEvent(...args);
  };
  return actors;
}

test("auth: with an operator, every route but the public ones answers 401 without a session", async () => {
  const { store, clock, task, app } = await setup();
  try {
    const routes = protectedRoutes(app, ids(task.id));
    const table = app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    const publicInTable = PUBLIC_ROUTES.filter((route) => table.includes(route));
    for (const route of ["GET /api/auth/session", "POST /api/auth/sign-in"]) assert.ok(publicInTable.includes(route), route);
    assert.equal(routes.length, table.length - publicInTable.length - 1);
    for (const route of ["GET /api/overview", `GET /api/tasks/${task.id}/stream`, `GET /api/tasks/${task.id}/screenshots/shot.png`,
      "POST /api/auth/sign-out", "GET /api/auth/me/sessions", `POST /api/tasks/${task.id}/approve`]) {
      assert.ok(routes.some(([method, path]) => `${method} ${path}` === route), route);
    }
    const snapshot = () => ({ tasks: store.listTasks(), events: store.eventsSince(0), repos: store.listRepos() });
    const before = snapshot();
    const expired = await signedIn(app);
    clock.now += 31 * DAY;
    for (const cookie of [undefined, "crane_session=not-a-session", expired]) {
      for (const [method, path] of routes) {
        const res = await call(app, method, path, { cookie });
        assert.equal(res.status, 401, `${method} ${path} with ${cookie}`);
        assert.deepEqual(await res.json(), SIGN_IN_FIRST);
        assert.equal(res.headers.get("set-cookie"), null);
      }
    }
    assert.deepEqual(snapshot(), before);
    // The public routes answer, and the built web app stays public.
    const status = await call(app, "GET", "/api/auth/session");
    assert.deepEqual(await status.json(), { required: true, signedIn: false, setUp: true, operator: null, session: null });
    assert.equal((await call(app, "GET", "/tasks")).status, 200);
  } finally { store.close(); }
});

test("auth: signing in sets an HttpOnly, SameSite=Strict session cookie that authorizes later calls", async () => {
  const { store, sam, log, app } = await setup();
  try {
    const res = await signIn(app, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0" } });
    assert.equal(res.status, 200);
    const [pair, ...attributes] = res.headers.get("set-cookie")!.split("; ");
    assert.match(pair!, /^crane_session=[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(attributes.sort(), ["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Strict"]);
    const status = await res.json() as AuthStatus;
    assert.deepEqual([status.required, status.signedIn, status.setUp, status.operator?.id], [true, true, true, sam!.id]);
    assert.deepEqual([status.session?.current, status.session?.client], [true, "Firefox on Linux"]);

    const cookie = pair!;
    assert.equal((await call(app, "GET", "/api/tasks", { cookie })).status, 200);
    assert.equal(((await (await call(app, "GET", "/api/auth/session", { cookie })).json()) as AuthStatus).session?.id, status.session?.id);

    // Signing in again on the same device replaces its session rather than leaving it signed in unseen.
    const again = await signedIn(app, { cookie });
    assert.equal((await call(app, "GET", "/api/tasks", { cookie })).status, 401);
    assert.equal((await call(app, "GET", "/api/tasks", { cookie: again })).status, 200);

    // Over HTTPS the cookie is Secure too.
    const secure = await app.request("https://localhost/api/auth/sign-in", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "Sam", password: PASSWORD }),
    });
    assert.equal(secure.status, 200);
    assert.ok(secure.headers.get("set-cookie")!.split("; ").includes("Secure"));

    assert.deepEqual(log, ["Signed in sam from unknown", "Signed in sam from unknown", "Signed in sam from unknown"]);
  } finally { store.close(); }
});

test("auth: the shared overview never answers a request without a session", async () => {
  const { store, app } = await setup();
  try {
    const cookie = await signedIn(app);
    // Fills the overview every tab shares for a second.
    assert.equal((await call(app, "GET", "/api/overview", { cookie })).status, 200);
    for (const stranger of [undefined, "crane_session=forged"]) {
      const res = await call(app, "GET", "/api/overview", { cookie: stranger });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), SIGN_IN_FIRST);
    }
    assert.equal((await call(app, "GET", "/api/overview", { cookie })).status, 200);
  } finally { store.close(); }
});

test("auth: a signed-in request runs as its operator, so the events it writes say who", async () => {
  const { store, sam, task, app } = await setup();
  try {
    const actors = spyActors(store);
    const cookie = await signedIn(app);
    // The route reads its body before deciding, so the operator holds across awaits.
    const approved = await call(app, "POST", `/api/tasks/${task.id}/approve`, { cookie, body: { merge: false } });
    assert.equal(approved.status, 200, await approved.clone().text());
    assert.ok(actors.length > 0);
    for (const actor of actors) assert.deepEqual(actor, { kind: "operator", id: sam!.id, name: "Sam" });

    // A new name applies from the next request, and nothing outside a request runs as anyone.
    assert.equal((await call(app, "POST", "/api/auth/me/name", { cookie, body: { name: "Sam Lee" } })).status, 200);
    const queued = store.createTask({ kind: "maintenance", title: "Cancel me", brief: "", repoId: null, autonomy: "propose" });
    assert.deepEqual(actors.at(-1), null, "the test's own write isn't anyone's");
    actors.length = 0;
    assert.equal((await call(app, "POST", `/api/tasks/${queued.id}/cancel`, { cookie })).status, 200);
    assert.ok(actors.length > 0);
    for (const actor of actors) assert.deepEqual(actor, { kind: "operator", id: sam!.id, name: "Sam Lee" });
    assert.equal(currentActor(), null);
  } finally { store.close(); }
});

test("auth: wrong passwords answer 401, then the client waits with Retry-After until its backoff passes", async () => {
  const { store, clock, log, app } = await setup();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await signIn(app, { password: WRONG_PASSWORD });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), WRONG);
    }
    // Refused before the password is checked, even the right one.
    const refused = await signIn(app);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.equal(refused.headers.get("set-cookie"), null);
    assert.deepEqual(await refused.json(), { error: "Too many failed attempts. Try again in 30 seconds.", retryAfterSeconds: 30 });
    assert.equal((await signIn(app, { client: "10.0.0.2", password: WRONG_PASSWORD })).status, 401, "another client doesn't wait");

    clock.now += 29_000;
    const waiting = await signIn(app);
    assert.equal(waiting.status, 429);
    assert.equal(waiting.headers.get("retry-after"), "1");
    clock.now += 1_000;
    assert.equal((await signIn(app)).status, 200);
    // The success cleared the client's failures.
    assert.equal((await signIn(app, { password: WRONG_PASSWORD })).status, 401);
    assert.equal((await signIn(app)).status, 200);

    assert.equal(log.filter((line) => line === 'Sign-in failed for "sam" from unknown').length, 6);
    assert.ok(log.includes('Sign-in failed for "sam" from 10.0.0.2'));
    assert.ok(log.every((line) => !line.includes(WRONG_PASSWORD) && !line.includes(PASSWORD)));
  } finally { store.close(); }
});

test("auth: failures also count per username, from anywhere, and overall", async () => {
  const { store, log, app } = await setup();
  try {
    await new OperatorActions(store).addOperator(HOST, { username: "kim", name: "Kim", role: "operator", password: PASSWORD });
    const wrong = (client: string, username = "sam") => signIn(app, { client, username, password: WRONG_PASSWORD });
    // Ten failures for Sam from five clients, none of them at its own limit.
    for (let i = 0; i < 10; i++) assert.equal((await wrong(`10.0.1.${i % 5}`)).status, 401);
    assert.equal((await signIn(app, { client: "10.0.2.1", username: "SAM" })).status, 429, "Sam waits, from anywhere");
    assert.equal((await wrong("10.0.2.1", "lee")).status, 401, "other usernames don't");
    // Thirty failures in all, and every username with a recent failure waits.
    for (let i = 0; i < 19; i++) assert.equal((await wrong(`10.0.3.${i}`, `guess${i}`)).status, 401);
    const everyone = await signIn(app, { client: "10.0.4.1", username: "lee" });
    assert.equal(everyone.status, 429);
    assert.equal(everyone.headers.get("retry-after"), "30");
    const tripped = "Too many failed sign-in attempts from all clients: usernames with recent failures must wait 30 seconds";
    assert.deepEqual(log.filter((line) => line.startsWith("Too many")), [tripped], "the log says once, not per refusal");

    // A username nobody has been guessing still gets its tries, one failure at a time.
    assert.equal((await signIn(app, { client: "10.0.4.2", username: "kim" })).status, 200, "Kim signs in during the attack");
    assert.equal((await wrong("10.0.4.3", "fresh")).status, 401);
    assert.equal((await wrong("10.0.4.4", "fresh")).status, 429, "then it waits like the rest");
    assert.ok(log.includes("Too many failed sign-in attempts from all clients: usernames with recent failures must wait 1 minute"));
  } finally { store.close(); }
});

test("auth: a limit waived for a fresh key lets one attempt at a time through, and reports each new wait", async () => {
  const now = 0;
  const limited: [string, number][] = [];
  const limiter = new AttemptLimiter(() => now, (limit, waitMs) => limited.push([limit.key, waitMs]));
  const fail = (limits: Parameters<AttemptLimiter["attempt"]>[0]) =>
    limiter.attempt(limits, async () => { throw new Error("wrong"); }).catch((err: Error) => err);
  const overall = limiter.limit("global", "links");
  for (let i = 0; i < 30; i++) await fail([overall]);
  assert.deepEqual(limited, [["links", FIRST_WAIT_MS]]);
  assert.ok((await fail([overall])) instanceof TooManyAttempts);

  const name = limiter.limit("username", "kim");
  const waived = limiter.limit("global", "links", name);
  assert.equal(limiter.fresh(name), true);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = limiter.attempt([name, waived], async () => { await held; return "ran"; });
  const second = await limiter.attempt([name, waived], async () => "ran").catch((err: Error) => err);
  assert.ok(second instanceof TooManyAttempts, "a second attempt waits while the first is in flight");
  release();
  assert.equal(await first, "ran");
  assert.equal(limiter.fresh(name), true, "a success leaves the username fresh");
  assert.ok((await fail([name, waived])) instanceof Error);
  assert.equal(limiter.fresh(name), false);
  assert.ok((await fail([name, waived])) instanceof TooManyAttempts);
  assert.deepEqual(limited, [["links", FIRST_WAIT_MS], ["links", 2 * FIRST_WAIT_MS]], "the waived failure still counts overall");
});

test("auth: the limiter's wait doubles to 15 minutes, cools down after a quiet window, and counts attempts in flight", async () => {
  let now = 0;
  const limiter = new AttemptLimiter(() => now);
  const client = limiter.limit("client", "10.0.0.1\u0007‮");
  assert.equal(client.key, "10.0.0.1");
  const fail = () => limiter.attempt([client], async () => { throw new Error("wrong"); }).catch((err: Error) => err);

  for (let i = 0; i < 4; i++) await fail();
  assert.equal(limiter.waitMs(client), 0);
  // Failures older than the window stop counting.
  now += LIMIT_WINDOW_MS;
  for (let i = 0; i < 4; i++) await fail();
  assert.equal(limiter.waitMs(client), 0);
  // Each failure comes just as the last wait ends.
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    now += waits.at(-1) ?? 0;
    await fail();
    waits.push(limiter.waitMs(client));
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 30, 30].map((n) => n * FIRST_WAIT_MS));
  assert.equal(MAX_WAIT_MS, 30 * FIRST_WAIT_MS);
  const refused = await limiter.attempt([client], async () => "ran").catch((err: Error) => err);
  assert.ok(refused instanceof TooManyAttempts);
  assert.equal(refused.retryAfterSeconds, 900);
  assert.equal(refused.message, "Too many failed attempts. Try again in 15 minutes.");

  // A whole window past the last wait, the key starts fresh.
  now += MAX_WAIT_MS + LIMIT_WINDOW_MS;
  await fail();
  assert.equal(limiter.waitMs(client), 0);

  // Errors that aren't failures don't count, and parallel attempts can't outrun the limit.
  const other = limiter.limit("client", "10.0.0.2");
  for (let i = 0; i < 6; i++) {
    await limiter.attempt([other], async () => { throw new Error("bad input"); }, () => false).catch(() => {});
  }
  assert.equal(limiter.waitMs(other), 0);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inFlight = Array.from({ length: 5 }, () => limiter.attempt([other], async () => { await held; throw new Error("wrong"); }).catch(() => {}));
  const sixth = await limiter.attempt([other], async () => "ran").catch((err: Error) => err);
  assert.ok(sixth instanceof TooManyAttempts);
  assert.equal(sixth.retryAfterSeconds, 1);
  release();
  await Promise.all(inFlight);
  assert.equal(limiter.waitMs(other), FIRST_WAIT_MS);
});

test("auth: signing out, signing out other devices and changing the password stop those cookies", async () => {
  const { store, app } = await setup();
  try {
    const status = async (cookie: string) => (await call(app, "GET", "/api/tasks", { cookie })).status;
    const sessions = async (res: Response) => (await res.json()) as OperatorSession[];
    const laptop = await signedIn(app);
    const phone = await signedIn(app);
    const listed = await sessions(await call(app, "GET", "/api/auth/me/sessions", { cookie: laptop }));
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((s) => s.current).length, 1);

    const others = await call(app, "POST", "/api/auth/me/sessions/sign-out-others", { cookie: laptop });
    assert.deepEqual((await sessions(others)).map((s) => s.current), [true]);
    assert.deepEqual([await status(laptop), await status(phone)], [200, 401]);

    // A new password keeps this device and signs out the rest, and only it signs in from then on.
    const tablet = await signedIn(app);
    const changed = await call(app, "POST", "/api/auth/me/password", { cookie: laptop, body: { current: PASSWORD, next: "a brand new password" } });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true });
    assert.deepEqual([await status(laptop), await status(tablet)], [200, 401]);
    assert.equal((await signIn(app)).status, 401);
    const desktop = await signedIn(app, { password: "a brand new password" });

    // One device signs another out.
    const desktopId = ((await (await call(app, "GET", "/api/auth/session", { cookie: desktop })).json()) as AuthStatus).session!.id;
    const left = await sessions(await call(app, "DELETE", `/api/auth/me/sessions/${desktopId}`, { cookie: laptop }));
    assert.equal(left.length, 1);
    assert.equal(await status(desktop), 401);

    // A device that signs itself out, either way, loses its cookie.
    const kiosk = await signedIn(app, { password: "a brand new password" });
    const kioskId = ((await (await call(app, "GET", "/api/auth/session", { cookie: kiosk })).json()) as AuthStatus).session!.id;
    const self = await call(app, "DELETE", `/api/auth/me/sessions/${kioskId}`, { cookie: kiosk });
    assert.deepEqual(await self.json(), []);
    assert.match(self.headers.get("set-cookie")!, /^crane_session=; Max-Age=0; Path=\//);
    assert.equal(await status(kiosk), 401);
    const out = await call(app, "POST", "/api/auth/sign-out", { cookie: laptop });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie")!, /^crane_session=; Max-Age=0; Path=\//);
    assert.deepEqual(await out.json(), { required: true, signedIn: false, setUp: true, operator: null, session: null });
    assert.equal(await status(laptop), 401);
  } finally { store.close(); }
});

test("auth: wrong current passwords count toward the limit, so a stolen session can't guess the password", async () => {
  const { store, log, app } = await setup();
  try {
    const cookie = await signedIn(app);
    const change = (current: string, next = "a brand new password") =>
      call(app, "POST", "/api/auth/me/password", { cookie, body: { current, next } });
    // A new password that's too short isn't a guess.
    for (let i = 0; i < 6; i++) assert.equal((await change(PASSWORD, "short")).status, 400);
    for (let i = 0; i < 5; i++) {
      const res = await change(WRONG_PASSWORD);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Your current password isn't right" });
    }
    const refused = await change(PASSWORD);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.equal(log.filter((line) => line.startsWith('Password change failed for "sam" from unknown')).length, 5);
  } finally { store.close(); }
});

test("auth: an operator renames themselves", async () => {
  const { store, sam, app } = await setup();
  try {
    const cookie = await signedIn(app);
    const renamed = await call(app, "POST", "/api/auth/me/name", { cookie, body: { name: "  Sam Lee " } });
    assert.equal(renamed.status, 200);
    const profile = await renamed.json() as OperatorProfile;
    assert.deepEqual([profile.id, profile.name, profile.username], [sam!.id, "Sam Lee", "sam"]);
    const blank = await call(app, "POST", "/api/auth/me/name", { cookie, body: { name: " " } });
    assert.equal(blank.status, 400);
    assert.deepEqual(await blank.json(), { error: "Enter a name of 1 to 60 characters" });
  } finally { store.close(); }
});

test("auth: an exposed factory with no operators refuses every protected route until one is added", async () => {
  const { store, task, addSam, app } = await setup({ exposed: true, operators: false });
  try {
    assert.match(NOT_SET_UP, /^Sign-in isn't set up\. .*crane operators add <username> --admin/);
    for (const [method, path] of protectedRoutes(app, ids(task.id))) {
      const res = await call(app, method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: NOT_SET_UP, signIn: true });
    }
    const lan = await app.request("http://192.168.1.20:4471/api/auth/session");
    assert.deepEqual(await lan.json(), { required: true, signedIn: false, setUp: false, operator: null, session: null });
    assert.equal((await signIn(app)).status, 401);

    // The first admin takes effect on the next request, without a restart.
    await addSam();
    const unsigned = await call(app, "GET", "/api/tasks");
    assert.deepEqual([unsigned.status, await unsigned.json()], [401, SIGN_IN_FIRST]);
    assert.equal((await call(app, "GET", "/api/tasks", { cookie: await signedIn(app) })).status, 200);
  } finally { store.close(); }
});

test("auth: on loopback with no operators the API answers as before, until an operator is added", async () => {
  const { store, clock, task, addSam, app } = await setup({ operators: false });
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const status = await call(app, "GET", "/api/auth/session");
    assert.deepEqual(await status.json(), { required: false, signedIn: false, setUp: false, operator: null, session: null });
    const actors = spyActors(store);
    for (const path of ["/api/overview", "/api/tasks", `/api/tasks/${task.id}`]) {
      const res = await call(app, "GET", path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("set-cookie"), null);
    }
    const approved = await call(app, "POST", `/api/tasks/${task.id}/approve`, { body: { merge: false } });
    assert.equal(approved.status, 200);
    assert.equal(store.getTask(task.id)?.status, "approved");
    assert.ok(actors.length > 0 && actors.every((actor) => actor === null), "nobody to attribute it to");
    // Own-account routes need someone signed in; the action's refusal keeps its status.
    const mine = await call(app, "GET", "/api/auth/me/sessions");
    assert.deepEqual([mine.status, await mine.json()], [401, { error: "Sign in to continue" }]);

    store.addEvent(task.id, "note", NOTE);
    const stream = await openStream(app, task.id);
    streams.push(stream.reader);
    await addSam();
    assert.equal((await call(app, "GET", "/api/tasks")).status, 401);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(stream.ended, 3000), "ended", "an open stream ends once sign-in is required");
  } finally {
    for (const reader of streams) await reader.cancel().catch(() => {});
    store.close();
  }
});

test("auth: sign-in from another origin is refused, so no page can sign the browser in", async () => {
  const { store, app } = await setup();
  try {
    const forgeries: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of forgeries) {
      const res = await signIn(app, { headers });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Cross-origin requests can't change anything" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal((await signIn(app, { headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } })).status, 200);
  } finally { store.close(); }
});

test("auth: screenshots and event streams need the session, and an open stream ends within 30 s of signing out", async () => {
  const { store, clock, task, app } = await setup();
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const cookie = await signedIn(app);
    const shot = `/api/tasks/${task.id}/screenshots/shot.png`;
    assert.equal((await call(app, "GET", shot)).status, 401);
    // Past the gate, an image the task never attached is just not found.
    assert.equal((await call(app, "GET", shot, { cookie })).status, 404);
    assert.equal((await call(app, "GET", `/api/tasks/${task.id}/stream`)).status, 401);

    store.addEvent(task.id, "note", NOTE);
    const stream = await openStream(app, task.id, cookie);
    streams.push(stream.reader);
    assert.equal((await call(app, "POST", "/api/auth/sign-out", { cookie })).status, 200);
    assert.equal(await within(stream.ended, 800), "open", "it re-checks periodically, not on every tick");
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(stream.ended, 3000), "ended");

    // A stream whose session is still good stays open past the re-check.
    const other = await openStream(app, task.id, await signedIn(app));
    streams.push(other.reader);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(other.ended, 1200), "open");
  } finally {
    for (const reader of streams) await reader.cancel().catch(() => {});
    store.close();
  }
});

test("auth: refusals about who is asking keep their status, and other errors stay 400", async () => {
  const app = new Hono();
  app.onError(errorResponse);
  app.get("/fail/:status", (c) => {
    const status = c.req.param("status");
    if (status === "429") throw new TooManyAttempts(90_000);
    if (status === "400") throw new Error("Bad input");
    throw new AccessError(Number(status) as 401 | 403, `Refused with ${status}`);
  });
  for (const status of [401, 403]) {
    const res = await app.request(`/fail/${status}`);
    assert.deepEqual([res.status, await res.json()], [status, { error: `Refused with ${status}` }]);
  }
  const limited = await app.request("/fail/429");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "90");
  assert.deepEqual(await limited.json(), { error: "Too many failed attempts. Try again in 2 minutes.", retryAfterSeconds: 90 });
  const bad = await app.request("/fail/400");
  assert.deepEqual([bad.status, await bad.json()], [400, { error: "Bad input" }]);
});

test("auth: without a socket, sign-in attempts count against the client 'unknown'", async () => {
  const store = new Store(":memory:");
  try {
    await new OperatorActions(store).addOperator(HOST, { username: "sam", name: "Sam", role: "admin", password: PASSWORD });
    const log: string[] = [];
    const app = createApp(store, { log: (line) => log.push(line) });
    assert.equal((await signIn(app, { password: WRONG_PASSWORD })).status, 401);
    assert.deepEqual(log, ['Sign-in failed for "sam" from unknown']);
  } finally { store.close(); }
});
