import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthStatus, InviteCheck, InviteSummary, TaskDetail } from "@crane/contracts";
import { PUBLIC_ROUTES } from "../src/server/auth.js";
import { STREAM_RECHECK_MS } from "../src/server/routes/tasks.js";
import { checkExposure } from "../src/server/security.js";
import { onFixtureCleanup } from "./support/fixtures.js";
import { within } from "./support/api-client.js";
import {
  PUBLIC_URL, PASSWORD, KAI_PASSWORD, WRONG_PASSWORD, assertSecretFree, attachScreenshot, hostCommand,
  json, reviewTask, secureCookie, setup,
} from "./support/auth-e2e.js";

type Issued = { invite: InviteSummary; token: string; path: string };

const ADMIN_ROUTES = [
  "GET /api/operators/invites", "POST /api/operators/invites", "DELETE /api/operators/invites/:id",
  "POST /api/operators/:id/role", "POST /api/operators/:id/reset", "POST /api/operators/:id/sign-out", "DELETE /api/operators/:id",
];

test("auth end to end: two operators behind an HTTPS proxy, over real loopback sockets", { timeout: 120_000 }, async (t) => {
  // The injected clock advances stream re-checks without waiting 30 seconds or changing the production interval.
  const clock = { now: Date.now() };
  const { store, log, app, base, send } = await setup(t, { publicUrl: PUBLIC_URL, trustProxy: true, clock: () => clock.now }, true);
  const exposure = checkExposure({ host: "127.0.0.1", publicUrl: PUBLIC_URL, operators: store.access.countOperators() });
  assert.equal(exposure.error, undefined);
  assert.equal(exposure.exposed, true);
  const task = reviewTask(t, store);
  const shot = attachScreenshot(store, task.id);
  const secrets = [PASSWORD, KAI_PASSWORD, WRONG_PASSWORD];
  const rememberCookie = (cookie: string) => { secrets.push(cookie.slice(cookie.indexOf("=") + 1)); return cookie; };
  const routes = app.routes.filter((route) => route.method !== "ALL");
  const table = routes.map((route) => `${route.method} ${route.path}`);

  await t.test("every registered protected route refuses an anonymous proxy client", async () => {
    assert.ok(table.includes("GET /*"));
    for (const route of PUBLIC_ROUTES) assert.ok(table.includes(route), route);
    const protectedRoutes = routes.filter((route) => `${route.method} ${route.path}` !== "GET /*"
      && !PUBLIC_ROUTES.includes(`${route.method} ${route.path}`));
    assert.equal(protectedRoutes.length, routes.length - PUBLIC_ROUTES.length - 1);
    for (const { method, path } of protectedRoutes) {
      assert.ok(path.startsWith("/api/"), `${method} ${path}`);
      const params: Record<string, string> = { id: task.id, name: shot.name };
      const target = path.replace(/:(\w+)/g, (_, key: string) => params[key] ?? key);
      await json(send(method, target), 401);
    }
    assert.equal((await json<AuthStatus>(send("GET", "/api/auth/session"))).signedIn, false);
  });

  const robin = rememberCookie(await secureCookie(await send("POST", "/api/auth/sign-in", {
    body: { username: "robin", password: PASSWORD },
  })));
  const issue = async () => {
    const issued = await json<Issued>(send("POST", "/api/operators/invites", { cookie: robin, body: { role: "operator", name: "Kai" } }));
    secrets.push(issued.token);
    assert.equal(issued.path, `/join#${issued.token}`);
    assert.equal(Date.parse(issued.invite.expiresAt) - clock.now, 7 * 86_400_000);
    return issued;
  };
  const invited = await issue();
  const checked = await json<InviteCheck>(send("POST", "/api/auth/invites/check", { body: { token: invited.token } }));
  assert.deepEqual([checked.name, checked.role, checked.invitedBy], ["Kai", "operator", "Robin"]);
  const kai = rememberCookie(await secureCookie(await send("POST", "/api/auth/invites/accept", {
    body: { token: invited.token, username: "kai", name: "Kai", password: KAI_PASSWORD },
  })));
  const kaiStatus = await json<AuthStatus>(send("GET", "/api/auth/session", { cookie: kai }));
  const kaiId = kaiStatus.operator!.id;
  assert.equal(kaiStatus.operator!.role, "operator");
  await json(send("POST", "/api/auth/invites/accept", {
    body: { token: invited.token, username: "another-kai", name: "Kai again", password: KAI_PASSWORD },
  }), 401);
  // A joined operator can also sign in by password on another device, with a Secure cookie.
  const kaiPhone = rememberCookie(await secureCookie(await send("POST", "/api/auth/sign-in", {
    body: { username: "kai", password: KAI_PASSWORD },
  })));
  const pending = await issue();
  assertSecretFree(log, secrets);

  await t.test("every admin route refuses Kai, including real operator and pending-invite targets", async () => {
    assert.deepEqual(table.filter((route) => route.includes(" /api/operators")).sort(), [...ADMIN_ROUTES, "GET /api/operators"].sort());
    const before = { operators: store.access.listOperators({ now: new Date(clock.now).toISOString(), idleSince: "2000-01-01" }),
      events: store.eventsSince(0) };
    for (const route of ADMIN_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      const target = path.replace(":id", path.includes("/invites/") ? pending.invite.id : kaiId);
      await json(send(method, target, { cookie: kai, body: { role: "admin", name: "Unauthorized invite" } }), 403);
    }
    assert.deepEqual(store.access.listOperators({ now: new Date(clock.now).toISOString(), idleSince: "2000-01-01" }), before.operators);
    assert.deepEqual(store.eventsSince(0), before.events);
    assert.equal((await json<InviteSummary[]>(send("GET", "/api/operators/invites", { cookie: robin }))).length, 1);
  });

  await t.test("Kai can read and approve; Robin's overlapping decline loses without changing attribution", async () => {
    await json<TaskDetail>(send("GET", `/api/tasks/${task.id}`, { cookie: kai }));
    let signalClaim!: () => void;
    const claimed = new Promise<void>((resolve) => { signalClaim = resolve; });
    const transition = store.transitionStatus.bind(store);
    store.transitionStatus = (...args: Parameters<typeof transition>) => {
      const won = transition(...args);
      if (args[0] === task.id && won) signalClaim();
      return won;
    };
    try {
      let finished = false;
      const approving = send("POST", `/api/tasks/${task.id}/approve`, { cookie: kai, body: { merge: false } });
      void approving.then(() => { finished = true; }, () => {});
      // Observe the real atomic write, then race the decline against the still-running worktree cleanup.
      await Promise.race([claimed, approving.then(() => assert.fail("approval returned before its claim"))]);
      assert.equal(finished, false, "the approval request is still in flight");
      const declining = send("POST", `/api/tasks/${task.id}/reject`, { cookie: robin });
      const [approved, declined] = await Promise.all([approving, declining]);
      assert.equal(approved.status, 200, await approved.text());
      assert.equal(declined.status, 400);
      assert.match((await declined.json() as { error: string }).error, /isn't waiting for review.*approved/);
    } finally { store.transitionStatus = transition; }
    const detail = await json<TaskDetail>(send("GET", `/api/tasks/${task.id}`, { cookie: kai }));
    assert.equal(detail.task.status, "approved");
    const decisions = detail.events.filter((event) => event.type === "operator");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.message, "Approved");
    assert.deepEqual(decisions[0]!.data?.actor, { kind: "operator", id: kaiId, name: "Kai" });
    const image = await send("GET", `/api/tasks/${task.id}/screenshots/${shot.name}`, { cookie: kai });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), shot.bytes);
  });

  /** Read actual SSE frames over the socket; keep draining until server EOF, independent of client abort cleanup. */
  const openStream = async (cookie: string) => {
    const controller = new AbortController();
    onFixtureCleanup(t, () => controller.abort());
    const response = await fetch(`${base}/api/tasks/${task.id}/stream?after=0`, {
      headers: { host: new URL(PUBLIC_URL).host, "x-forwarded-proto": "https", cookie },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    let frames = "";
    const ended = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return "ended";
        frames += decoder.decode(chunk.value, { stream: true });
      }
    })();
    void ended.catch(() => {}); // Abort during failed-test teardown must not leave an unhandled rejection.
    // Observe data, not just headers, before revoking either session.
    const until = Date.now() + 3000;
    while (!frames.includes('"name":"Kai"')) {
      assert.ok(Date.now() < until, "the stream never delivered Kai's attributed event");
      assert.equal(await within(ended, 20), "open", "stream ended before the attributed event");
    }
    return { ended, frames: () => frames };
  };
  const kaiStream = await openStream(kai);
  const robinStream = await openStream(robin);
  store.addEvent(task.id, "note", "A new live event after both streams opened");
  const liveUntil = Date.now() + 3000;
  while (!kaiStream.frames().includes("A new live event") || !robinStream.frames().includes("A new live event")) {
    assert.ok(Date.now() < liveUntil, "both streams receive newly written events");
    assert.equal(await within(kaiStream.ended, 20), "open");
  }

  await t.test("forged origins are refused and forwarded client failures are rate limited", async () => {
    await json(send("POST", `/api/tasks/${task.id}/reject`, { cookie: robin, headers: { origin: "https://forged.example" } }), 403);
    for (let i = 0; i < 5; i++) await json(send("POST", "/api/auth/sign-in", {
      client: "198.51.100.99", body: { username: "robin", password: WRONG_PASSWORD },
    }), 401);
    const limited = await send("POST", "/api/auth/sign-in", {
      client: "198.51.100.99", body: { username: "robin", password: WRONG_PASSWORD },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "30");
    await limited.text();
    // The proxy is not the client key: a different forwarded address can still sign in.
    rememberCookie(await secureCookie(await send("POST", "/api/auth/sign-in", {
      client: "198.51.100.100", body: { username: "robin", password: PASSWORD },
    })));
    assert.ok(log.some((line) => line.includes("198.51.100.99")));
  });

  await t.test("removal and CLI sign-out invalidate cookies and end already-open streams", async () => {
    await json(send("DELETE", `/api/operators/${kaiId}`, { cookie: robin }));
    for (const cookie of [kai, kaiPhone]) await json(send("GET", "/api/overview", { cookie }), 401);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(kaiStream.ended, 3000), "ended");
    assert.equal(await within(robinStream.ended, 50), "open", "Robin's stream stays live");
    const detail = await json<TaskDetail>(send("GET", `/api/tasks/${task.id}`, { cookie: robin }));
    assert.deepEqual(detail.events.find((event) => event.message === "Approved")!.data?.actor, { kind: "operator", id: kaiId, name: "Kai" });
    await hostCommand(log, ["auth", "sign-out", "--all"]);
    await json(send("GET", "/api/overview", { cookie: robin }), 401);
    clock.now += STREAM_RECHECK_MS;
    assert.equal(await within(robinStream.ended, 3000), "ended");
    assert.ok(kaiStream.frames().includes('"name":"Kai"'));
    assertSecretFree(log, secrets);
  });
});

test("auth end to end: loopback with no operators keeps the dashboard and API open", { timeout: 30_000 }, async (t) => {
  const { base } = await setup(t);
  const status = await json<AuthStatus>(fetch(`${base}/api/auth/session`));
  assert.deepEqual([status.required, status.setUp, status.signedIn], [false, false, false]);
  await json(fetch(`${base}/api/overview`));
  await json(fetch(`${base}/api/tasks`));
  const dashboard = await fetch(`${base}/tasks`);
  assert.equal(dashboard.status, 200);
  assert.ok((await dashboard.text()).length > 0);
});
