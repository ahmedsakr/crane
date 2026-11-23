import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actorSnapshot, craneHome, worktreesDir } from "@crane/backend-runtime";
import { RUNNER_LIMITS, type EventActor, type Overview, type RunnerJobKind, type TaskDetail } from "@crane/contracts";
import { OperatorActions, type IssuedRunner } from "@crane/factory/actions";
import { createApp } from "@crane/http-server";
import { Store } from "@crane/storage";
import { PUBLIC_ROUTES } from "../packages/http-server/src/auth.js";
import { call } from "./support/api-client.js";
import { testHome } from "./support/fixtures.js";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const heartbeat = { drivers: ["codex"], capacity: 1, version: "0.1.0" };
const heartbeatPath = "/api/runner/heartbeat";
const claimPath = "/api/runner/jobs/claim";
const rejected = { error: "Unauthorized" };

function setup(t: TestContext) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  let now = Date.now();
  const clock = () => now;
  const actions = new OperatorActions(store, clock);
  const at = new Date(now).toISOString();
  const makeOperator = (username: string, name: string, role: "admin" | "operator" = "operator") => {
    const { id } = store.access.createOperator({ username, name, role, passwordHash: "unused", at });
    const token = randomBytes(32).toString("base64url");
    store.access.createSession({ operatorId: id, tokenHash: digest(token), at, expiresAt: new Date(now + 86_400_000).toISOString(), client: null });
    return { actor: { kind: "operator", id, name } satisfies EventActor, cookie: `crane_session=${token}` };
  };
  const robin = makeOperator("robin", "Robin");
  const kai = makeOperator("kai", "Kai");
  const admin = makeOperator("sam", "Sam", "admin");
  const app = createApp(store, { clock, clientKey: (c) => c.req.header("x-client") ?? "test-client" });
  const task = store.createTask({ kind: "maintenance", title: "Remote task", brief: "", repoId: null, autonomy: "propose" });
  const queueJob = (runnerId: string, kind: RunnerJobKind = "work") => store.runners.createJob({
    taskId: task.id, runnerId, kind, at, payload: { title: task.title, driver: "codex" },
  });
  return { store, actions, app, task, robin, kai, admin, queueJob, advance: (ms: number) => { now += ms; } };
}

async function checked(response: Response, status: number, secrets: string[] = []): Promise<string> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  for (const secret of secrets) {
    for (const value of [secret, digest(secret)]) {
      assert.ok(!text.includes(value), "response body omitted the credential");
      assert.ok(!JSON.stringify([...response.headers]).includes(value), "response headers omitted the credential");
    }
  }
  return text;
}

test("runner API: bearer credentials and operator sessions have separate gates and limits", async (t) => {
  const { actions, app, robin } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  const wrong = randomBytes(32).toString("base64url");
  for (const headers of [{}, bearer(wrong), { authorization: `Basic ${token}` }]) {
    const res = await call(app, "POST", heartbeatPath, { headers, cookie: robin.cookie, body: heartbeat });
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(JSON.parse(await checked(res, 401, [token, wrong])), rejected);
  }
  // Encoded unreserved characters route to the same bearer-only path.
  assert.deepEqual(JSON.parse(await checked(await call(app, "POST", "/api/%72unner/heartbeat", { cookie: robin.cookie }), 401)), rejected);
  // Requests without a bearer token aren't guesses: only the wrong tokens count toward the client's limit.
  for (let failure = 2; failure <= 5; failure++) {
    await checked(await call(app, "POST", heartbeatPath, { headers: bearer(wrong), body: heartbeat }), 401);
  }
  const limited = await call(app, "POST", heartbeatPath, { headers: bearer(token), body: heartbeat });
  assert.equal(limited.headers.get("retry-after"), "30");
  await checked(limited, 429, [token]);
  assert.deepEqual(JSON.parse(await checked(await call(app, "POST", heartbeatPath, { body: heartbeat }), 401)), rejected);
  const ok = await call(app, "POST", heartbeatPath, { client: "fresh", headers: bearer(token), body: heartbeat });
  assert.deepEqual(JSON.parse(await checked(ok, 200, [token])), { cancel: [] });
  await checked(await call(app, "GET", "/api/runners", { headers: bearer(token) }), 401, [token]);
  await checked(await call(app, "GET", "/api/runners", { cookie: robin.cookie }), 200, [token]);
  actions.removeRunner(robin.actor, runner.id);
  const revoked = await call(app, "POST", heartbeatPath, { client: "fresh", headers: bearer(token), body: heartbeat });
  assert.deepEqual(JSON.parse(await checked(revoked, 401, [token])), rejected);
  assert.deepEqual(PUBLIC_ROUTES, [
    "GET /api/auth/session", "POST /api/auth/sign-in", "POST /api/auth/invites/check", "POST /api/auth/invites/accept",
  ]);
});

test("runner API: only a job's container can lease, read or mutate it", async (t) => {
  const { store, actions, app, task, robin, kai, queueJob } = setup(t);
  const own = actions.addRunner(robin.actor, { name: "Laptop" });
  const other = actions.addRunner(kai.actor, { name: "Desk" });
  const { id } = queueJob(own.runner.id);
  const secrets = [own.token, other.token];
  const send = (method: string, path: string, body?: unknown) => call(app, method, path, { headers: bearer(other.token), body });
  assert.equal(await checked(await send("POST", claimPath), 200, secrets), "null");
  const headers = bearer(own.token);
  const claim = await checked(await call(app, "POST", claimPath, { headers }), 200, secrets);
  assert.equal(JSON.parse(claim).id, id);
  const job = `/api/runner/jobs/${id}`;
  for (const [method, suffix] of [["GET", "bundle"], ["POST", "events"], ["POST", "session"], ["PUT", "screenshots/shot.png"], ["POST", "result"]] as const) {
    const response = await checked(await send(method, `${job}/${suffix}`), 404, secrets);
    assert.equal(response, await checked(await send(method, `/api/runner/jobs/j-missing/${suffix}`), 404, secrets));
  }
  const lease = store.runners.job(id)!.leaseExpiresAt;
  assert.deepEqual(JSON.parse(await checked(await send("POST", heartbeatPath, { ...heartbeat, jobs: [id] }), 200, secrets)), { cancel: [id] });
  assert.equal(store.runners.job(id)?.leaseExpiresAt, lease);
  const addEvent = store.addEvent.bind(store);
  const actors: (EventActor | null)[] = [];
  t.mock.method(store, "addEvent", (...args: Parameters<Store["addEvent"]>) => {
    actors.push(actorSnapshot());
    return addEvent(...args);
  });
  const events = await call(app, "POST", `${job}/events`, {
    headers, cookie: robin.cookie, body: { events: [{ type: "note", message: "From container" }, { type: "operator", message: "Discarded" }] },
  });
  assert.deepEqual(JSON.parse(await checked(events, 200, secrets)), { accepted: 1 });
  assert.deepEqual(actors, [null]);
  assert.ok(store.listEvents(task.id).some((e) => e.message === "From container"));
  await checked(await call(app, "POST", `${job}/session`, { headers, body: { sessionId: "session-1" } }), 204);
  assert.equal(store.runners.job(id)?.sessionId, "session-1");
  await checked(await call(app, "POST", `${job}/result`, { headers, body: { outcome: "succeeded" } }), 204);
  assert.equal(store.runners.job(id)?.state, "returned");
});

test("runner API: request caps stop declared, undeclared and underdeclared bodies", async (t) => {
  const { store, actions, app, robin, queueJob } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  const { id } = queueJob(runner.id);
  await checked(await call(app, "POST", claimPath, { headers: bearer(token) }), 200);
  const job = `/api/runner/jobs/${id}`;
  const cases = [
    ["POST", heartbeatPath, RUNNER_LIMITS.controlBytes, "application/json"],
    ["POST", claimPath, RUNNER_LIMITS.controlBytes, "application/json"],
    ["POST", `${job}/session`, RUNNER_LIMITS.controlBytes, "application/json"],
    ["POST", `${job}/events`, RUNNER_LIMITS.eventBatchBytes, "application/json"],
    ["PUT", `${job}/screenshots/shot.png`, RUNNER_LIMITS.screenshotBytes, "application/octet-stream"],
    ["POST", `${job}/result`, RUNNER_LIMITS.resultBytes, "application/json"],
    ["POST", `${job}/result`, RUNNER_LIMITS.bundleBytes, "multipart/form-data; boundary=demo"],
  ] as const;
  for (const [method, path, cap, type] of cases) {
    for (const length of [cap + 1, undefined, 1]) {
      const headers = new Headers({ ...bearer(token), "content-type": type });
      if (length !== undefined) headers.set("content-length", String(length));
      let reads = 0;
      const chunk = new Uint8Array(Math.min(cap, 1024 * 1024));
      const over = Math.ceil(cap / chunk.byteLength) + 1;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (++reads > over + 2) controller.close();
          else controller.enqueue(chunk);
        },
      }, { highWaterMark: 0 });
      const init = { method, headers, body, duplex: "half" as const };
      await checked(await app.request(path, init), 413);
      if (length === cap + 1) assert.equal(reads, 0, path);
      else assert.ok(reads >= over && reads < over + 2, `${path} read ${reads} chunks`);
    }
  }
  assert.equal(store.runners.job(id)?.state, "claimed");
  assert.equal(store.runners.job(id)?.sessionId, null);
});

test("runner API: accepts raw screenshots and multipart job returns", async (t) => {
  testHome(t);
  const { store, actions, app, task, robin, queueJob } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  const headers = bearer(token);
  const { id } = queueJob(runner.id);
  const job = `/api/runner/jobs/${id}`;
  const worktree = join(worktreesDir(), task.id);
  mkdirSync(worktree);
  await checked(await call(app, "POST", claimPath, { headers }), 200);
  const bytes = Uint8Array.of(12, 34, 56);
  const screenshot = await app.request(`${job}/screenshots/shot.png`, { method: "PUT", headers, body: bytes });
  const { path } = JSON.parse(await checked(screenshot, 200, [token]));
  assert.deepEqual(readFileSync(join(worktree, path)), Buffer.from(bytes));
  const form = new FormData();
  form.set("result", JSON.stringify({ outcome: "succeeded", finalText: "Report", validation: ["ignored"] }));
  form.set("bundle", new Blob([bytes]), "return.bundle");
  await checked(await app.request(`${job}/result`, { method: "POST", headers, body: form }), 204);
  assert.deepEqual(store.runners.job(id)?.result, { outcome: "succeeded", finalText: "Report" });
  assert.deepEqual(readFileSync(join(craneHome(), "runner-incoming", `${id}.bundle`)), Buffer.from(bytes));
});

test("runner API: streams the bundle with its refs and removes the temporary file", { timeout: 5000 }, async (t) => {
  testHome(t);
  const { actions, app, robin, queueJob } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  const headers = bearer(token);
  const { id } = queueJob(runner.id);
  await checked(await call(app, "POST", claimPath, { headers }), 200);
  const path = join(craneHome(), "download.bundle");
  const refs = { base: "refs/crane/outgoing/job/base" };
  writeFileSync(path, "bundle bytes");
  let removed!: () => void;
  const cleanup = new Promise<void>((resolve) => { removed = resolve; });
  const bundleFor: OperatorActions["jobBundle"] = async (record, jobId, have) => {
    assert.equal(record.id, runner.id);
    assert.equal(jobId, id);
    assert.deepEqual(have, ["one", "two"]);
    return { path, bytes: 12, refs, remove: () => { rmSync(path); removed(); } };
  };
  t.mock.method(OperatorActions.prototype, "jobBundle", bundleFor);
  const response = await call(app, "GET", `/api/runner/jobs/${id}/bundle?have=one&have=two`, { headers });
  assert.equal(response.headers.get("content-type"), "application/x-git-bundle");
  assert.equal(response.headers.get("content-length"), "12");
  assert.deepEqual(JSON.parse(response.headers.get("x-crane-bundle-refs")!), refs);
  assert.equal(await checked(response, 200, [token]), "bundle bytes");
  await cleanup;
  assert.equal(existsSync(path), false);
});

test("operator API: containers are managed by their owners or an admin, with one-time tokens", async (t) => {
  const { actions, app, task, robin, kai, admin } = setup(t);
  const add = await call(app, "POST", "/api/runners", { cookie: robin.cookie, body: { name: "Laptop" } });
  assert.equal(add.headers.get("cache-control"), "no-store");
  const issued = JSON.parse(await checked(add, 201)) as IssuedRunner;
  const { runner, token } = issued;
  assert.deepEqual(Object.keys(issued).sort(), ["runner", "token"]);
  assert.ok(!JSON.stringify(runner).includes(token) && !JSON.stringify(issued).includes(digest(token)));
  assert.ok(actions.authenticateRunner(token));
  const path = `/api/runners/${runner.id}`;
  const send = (method: string, path: string, cookie: string, body?: unknown) => call(app, method, path, { cookie, body });
  const secrets = [token];
  assert.deepEqual(JSON.parse(await checked(await send("GET", "/api/runners", kai.cookie), 200, secrets)), []);
  assert.match(await checked(await send("GET", "/api/runners", admin.cookie), 200, secrets), /Laptop/);
  await checked(await send("POST", "/api/runners", admin.cookie, { name: "Impersonation", operator: "robin" }), 403, secrets);
  await checked(await send("PATCH", path, kai.cookie, { name: "Other" }), 403, secrets);
  await checked(await send("POST", `${path}/rotate`, kai.cookie), 403, secrets);
  await checked(await send("DELETE", path, kai.cookie), 403, secrets);
  await checked(await send("PATCH", path, robin.cookie, { name: "Partial edit", capacity: 99 }), 400, secrets);
  assert.match(await checked(await send("GET", "/api/runners", robin.cookie), 200, secrets), /Laptop/);
  const updated = JSON.parse(await checked(await send("PATCH", path, robin.cookie, { name: "Work", capacity: 2 }), 200, secrets));
  assert.deepEqual([updated.name, updated.capacity], ["Work", 2]);
  const route = `/api/tasks/${task.id}/runner`;
  await checked(await send("PUT", route, kai.cookie, { runnerId: runner.id }), 403, secrets);
  await checked(await send("PUT", route, admin.cookie, { runnerId: runner.id }), 403, secrets);
  await checked(await send("PUT", route, robin.cookie, {}), 400, secrets);
  const routed = JSON.parse(await checked(await send("PUT", route, robin.cookie, { runnerId: runner.id }), 200, secrets));
  assert.equal(routed.runnerId, runner.id);
  const agent = `/api/tasks/${task.id}/agent`;
  await checked(await send("POST", agent, kai.cookie, { runnerId: null }), 403, secrets);
  const cleared = JSON.parse(await checked(await send("POST", agent, robin.cookie, { runnerId: null, driver: "codex" }), 200, secrets));
  assert.deepEqual([cleared.runnerId, cleared.driver], [null, "codex"]);
  const policy = "/api/settings/runners-required";
  await checked(await send("GET", policy, robin.cookie), 403, secrets);
  await checked(await send("PUT", policy, robin.cookie, { value: "on" }), 403, secrets);
  assert.deepEqual(JSON.parse(await checked(await send("GET", policy, admin.cookie), 200, secrets)), { value: "off" });
  assert.deepEqual(JSON.parse(await checked(await send("PUT", policy, admin.cookie, { value: "on" }), 200, secrets)), { value: "on" });
  await checked(await send("PUT", route, robin.cookie, { runnerId: null }), 403, secrets);
  const rotation = await send("POST", `${path}/rotate`, admin.cookie);
  assert.equal(rotation.headers.get("cache-control"), "no-store");
  const rotated = JSON.parse(await checked(rotation, 200, secrets)) as IssuedRunner;
  assert.ok(rotated.token && rotated.token !== token);
  assert.deepEqual(Object.keys(rotated).sort(), ["runner", "token"]);
  assert.ok(!JSON.stringify(rotated.runner).includes(rotated.token) && !JSON.stringify(rotated).includes(digest(rotated.token)));
  assert.equal(actions.authenticateRunner(token), null);
  assert.equal(actions.authenticateRunner(rotated.token)?.id, runner.id);
  await checked(await send("DELETE", path, robin.cookie), 204, [...secrets, rotated.token]);
  assert.equal(actions.authenticateRunner(rotated.token), null);
});

test("operator API: default containers are private to the owner and used on task intake", async (t) => {
  const { actions, app, store, robin, kai, admin } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  const path = "/api/runners/default";
  const send = (method: string, cookie?: string, body?: unknown) => call(app, method, path, { cookie, body });
  const body = async (response: Response, status = 200) => JSON.parse(await checked(response, status, [token]));
  await body(await send("GET"), 401);
  await body(await send("PUT", kai.cookie, { runnerId: runner.id }), 403);
  await body(await send("PUT", robin.cookie, {}), 400);
  assert.deepEqual(await body(await send("PUT", robin.cookie, { runnerId: runner.id })), { runnerId: runner.id });
  assert.deepEqual(await body(await send("GET", robin.cookie)), { runnerId: runner.id, required: false });
  assert.deepEqual(await body(await send("GET", admin.cookie)), { runnerId: null, required: false });
  const repoId = store.addRepo({ path: "/repo" }).id;
  const create = (routing = {}) => call(app, "POST", "/api/tasks", {
    cookie: robin.cookie, body: { kind: "maintenance", title: "Routing", brief: "Check routing", repoId, autonomy: "observe", ...routing },
  });
  assert.equal((await body(await create(), 201)).runnerId, runner.id);
  assert.equal((await body(await create({ runnerId: runner.id }), 201)).runnerId, runner.id);
  assert.equal((await body(await create({ runnerId: null }), 201)).runnerId, null);
  actions.setRunnersRequired(admin.actor, "on");
  assert.deepEqual(await body(await send("GET", robin.cookie)), { runnerId: runner.id, required: true });
  await body(await create({ runnerId: null }), 403);
  await checked(await call(app, "DELETE", `/api/runners/${runner.id}`, { cookie: admin.cookie }), 204, [token]);
  assert.deepEqual(await body(await send("GET", robin.cookie)), { runnerId: null, required: true });
});

test("operator API: overview, queue, list and task detail report container presence", async (t) => {
  const { actions, app, task, robin, advance } = setup(t);
  const { runner, token } = actions.addRunner(robin.actor, { name: "Laptop" });
  actions.setTaskRunner(robin.actor, task.id, runner.id);
  const by = { cookie: robin.cookie };
  const label = "Robin's container 'Laptop'";
  for (const phase of ["initial", "heartbeat", "expired", "removed"] as const) {
    const online = phase === "heartbeat";
    if (online) await checked(await call(app, "POST", heartbeatPath, { headers: bearer(token), body: heartbeat }), 200, [token]);
    if (phase === "expired") {
      advance((RUNNER_LIMITS.offlineAfterSeconds + 1) * 1000);
      // An ordinary mutation invalidates the overview's short shared cache.
      await checked(await call(app, "PATCH", `/api/runners/${runner.id}`, { ...by, body: { name: "Laptop" } }), 200, [token]);
    }
    if (phase === "removed") await checked(await call(app, "DELETE", `/api/runners/${runner.id}`, by), 204, [token]);
    const overview = JSON.parse(await checked(await call(app, "GET", "/api/overview", by), 200, [token])) as Overview;
    const detail = JSON.parse(await checked(await call(app, "GET", `/api/tasks/${task.id}`, by), 200, [token])) as TaskDetail;
    const rows = await Promise.all(["/api/tasks", "/api/tasks/queue"].map(async (path) =>
      JSON.parse(await checked(await call(app, "GET", path, by), 200, [token])) as Overview["inFlight"]));
    assert.deepEqual(overview.runners.map((lane) => [lane.id, lane.label, lane.online]), phase === "removed" ? [] : [[runner.id, label, online]]);
    for (const payload of [detail.task, overview.inFlight[0]!, ...rows.map((items) => items[0]!)]) {
      assert.deepEqual([payload.runnerId, payload.runnerLabel, payload.runnerOnline], [runner.id, label, online]);
    }
  }
});
