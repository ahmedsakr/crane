import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScheduled, type NewTask } from "@crane/contracts";
import type { AgentDriver } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { OperatorActions, checkScheduledAt } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { Factory } from "../src/factory/orchestrator.js";
import { localStartTime, parseStartTime } from "../web/src/lib/schedule.js";

const NOW = new Date("2030-06-15T12:00:00.000Z");
const DUE = "2030-06-15T13:00:00.000Z";

test("scheduling: browser dates use the local timezone and reject empty, past and nonexistent times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2029-01-01T00:00:00Z") });
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Toronto";
  try {
    assert.equal(localStartTime(DUE), "2030-06-15T09:00");
    assert.equal(parseStartTime("2030-06-15T09:00"), DUE);
    assert.equal(parseStartTime(null), null);
    for (const value of ["", "invalid", "2030-02-30T09:00", "2030-03-10T02:30", "2028-06-15T09:00"]) {
      assert.throws(() => parseStartTime(value), /Choose a/, value);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const make = (extra: Partial<NewTask> = {}) => actions.createTask({
    kind: "maintenance", title: "Task", brief: "Do it", repoId: repo.id, autonomy: "observe", ...extra,
  });
  return { store, actions, repo, make };
}

test("scheduling: accepts explicit timezones, normalizes to UTC, rejects invalid or past times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  assert.equal(checkScheduledAt(undefined), null);
  assert.equal(checkScheduledAt(null), null);
  assert.equal(checkScheduledAt("2030-06-15T09:00:00-04:00"), DUE);
  assert.equal(checkScheduledAt("2030-06-15T15:00+02:00"), DUE);
  assert.equal(checkScheduledAt("2032-02-29T12:30:00Z"), "2032-02-29T12:30:00.000Z");
  for (const input of ["", 42, true, {}, [], "tomorrow", "2030-06-15", "2030-06-15T13:00:00", "2030-02-29T13:00Z",
    "2030-04-31T13:00Z", "2030-06-00T13:00Z", "2030-06-15T24:00Z", "2030-06-15T13:60Z", "2030-06-15T13:00:60Z",
    "2030-13-01T13:00Z", "2030-06-15T13:00+25:00", "9999-12-31T23:59:59-01:00", NOW.toISOString(), "2029-01-01T13:00Z"]) {
    assert.throws(() => checkScheduledAt(input), /Start time|start time/, JSON.stringify(input));
  }
});

test("scheduling: skips future work without blocking others, and claims at the exact due time once", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { store, make } = setup();
  try {
    const future = make({ scheduledAt: "2030-06-15T09:00:00-04:00" });
    assert.equal(future.status, "queued");
    assert.equal(future.scheduledAt, DUE);
    assert.equal(isScheduled(future), true);
    assert.equal(future.startedAt, null);
    assert.equal(store.getTask(future.id)!.scheduledAt, DUE);
    assert.equal(store.listEvents(future.id)[0]!.data?.scheduledAt, DUE);
    const immediate = make();
    assert.equal(immediate.scheduledAt, null);
    assert.equal(store.claimNextTask("a-jib")?.id, immediate.id);
    assert.equal(store.claimNextTask("a-boom"), null);
    t.mock.timers.setTime(Date.parse(DUE) - 1);
    assert.equal(store.claimNextTask("a-boom"), null);
    t.mock.timers.setTime(Date.parse(DUE));
    assert.equal(isScheduled(store.getTask(future.id)!), false, "due reads as queued again");
    assert.equal(store.claimNextTask("a-boom")?.id, future.id);
    assert.equal(store.getTask(future.id)!.startedAt, DUE);
    assert.equal(store.claimNextTask("a-jib"), null);
  } finally { store.close(); }
});

test("scheduling: due work still honors prerequisites and assignment; waiving never clears time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { store, actions, make } = setup();
  try {
    const prerequisite = make();
    store.setStatus(prerequisite.id, "needs_review");
    const held = make({ scheduledAt: DUE, prerequisites: [prerequisite.id] });
    const waived = make({ scheduledAt: DUE, prerequisites: [prerequisite.id] });
    actions.waivePrerequisites(waived.id);
    assert.equal(store.claimNextTask("a-jib"), null, "even waived tasks wait for their start time");
    t.mock.timers.setTime(Date.parse(DUE));
    assert.equal(store.claimNextTask("a-jib")?.id, waived.id);
    assert.equal(store.claimNextTask("a-boom"), null, "a due time never waives prerequisites");
    actions.schedule(held.id, null);
    assert.equal(store.claimNextTask("a-boom"), null, "Start now never waives prerequisites either");
    store.setStatus(prerequisite.id, "done");
    assert.equal(store.claimNextTask("a-boom")?.id, held.id);

    const assigned = store.createTask({ kind: "maintenance", title: "Assigned", brief: "", repoId: null,
      autonomy: "observe", assignee: "a-boom", scheduledAt: "2030-06-15T10:00:00-04:00" });
    assert.equal(assigned.scheduledAt, "2030-06-15T14:00:00.000Z", "store callers also save UTC timestamps");
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true }), null);
    t.mock.timers.setTime(Date.parse("2030-06-15T14:00:00Z"));
    assert.equal(store.claimNextTask("a-jib"), null);
    assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true })?.id, assigned.id);
  } finally { store.close(); }
});

test("scheduling: rescheduling and cancellation are recorded; other states cannot be rescheduled", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { store, actions, make } = setup();
  try {
    const task = make();
    assert.equal(actions.schedule(task.id, DUE).scheduledAt, DUE);
    const later = "2030-06-15T14:00:00.000Z";
    assert.equal(actions.schedule(task.id, later).scheduledAt, later);
    const events = store.listEvents(task.id);
    assert.throws(() => actions.schedule(task.id, "yesterday"), /ISO 8601/);
    assert.equal(store.getTask(task.id)!.scheduledAt, later);
    assert.deepEqual(store.listEvents(task.id), events);
    assert.equal(actions.schedule(task.id, null).scheduledAt, null);
    assert.deepEqual(store.listEvents(task.id).at(-1)!.data, { scheduledAt: null });
    assert.equal(store.claimNextTask("a-jib")?.id, task.id);
    for (const status of ["running", "needs_review", "done", "failed", "cancelled", "approved", "merging", "merged", "rejected"] as const) {
      store.updateTask(task.id, { status });
      const before = store.getTask(task.id);
      const history = store.listEvents(task.id);
      assert.throws(() => actions.schedule(task.id, DUE), /isn't queued/);
      assert.deepEqual(store.getTask(task.id), before);
      assert.deepEqual(store.listEvents(task.id), history);
    }
    const cancelled = make({ scheduledAt: DUE });
    actions.cancel(cancelled.id);
    t.mock.timers.setTime(Date.parse(DUE));
    assert.equal(store.claimNextTask("a-jib"), null);
    assert.equal(actions.retry(cancelled.id).scheduledAt, null, "Run again is a fresh immediate task");
  } finally { store.close(); }
});

test("scheduling: persists across store reopen, catches up overdue tasks, and migrates old databases", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dir = mkdtempSync(join(tmpdir(), "crane-scheduling-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const input: NewTask = { kind: "maintenance", title: "Existing", brief: "", repoId: null, autonomy: "observe" };
    const old = store.createTask(input);
    store.db.exec("ALTER TABLE tasks DROP COLUMN scheduled_at");
    store.close();
    store = new Store(file);
    assert.deepEqual(store.getTask(old.id), old, "migration defaults old tasks to immediate");
    const future = store.createTask({ ...input, scheduledAt: DUE });
    store.close();
    store = new Store(file);
    assert.equal(store.getTask(future.id)!.scheduledAt, DUE);
    assert.equal(store.claimNextTask("a-jib")?.id, old.id);
    assert.equal(store.claimNextTask("a-boom"), null);
    store.close();
    t.mock.timers.setTime(Date.parse(DUE) + 3_600_000);
    store = new Store(file);
    const other = new Store(file);
    try {
      assert.equal(store.claimNextTask("a-jib")?.id, future.id, "overdue work is picked up after restart");
      assert.equal(other.claimNextTask("a-boom"), null, "another connection cannot claim it again");
    } finally { other.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("scheduling: crew capacity counts all due unassigned work, excluding future and assigned tasks", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { store, make } = setup();
  try {
    for (let i = 0; i < 25; i++) make({ scheduledAt: DUE });
    assert.equal(store.queuedForAnyone(), 0, "future tasks beyond the overview preview do not suggest more crew");
    const immediate = make();
    assert.equal(store.queuedForAnyone(), 1);
    store.createTask({ kind: "maintenance", title: "Assigned", brief: "", repoId: null, autonomy: "observe", assignee: "a-jib" });
    assert.equal(store.queuedForAnyone(), 1);
    store.claimNextTask("a-boom");
    assert.equal(store.getTask(immediate.id)!.status, "running");
    assert.equal(store.queuedForAnyone(), 0);
    t.mock.timers.setTime(Date.parse(DUE));
    assert.equal(store.queuedForAnyone(), 25);
  } finally { store.close(); }
});

test("scheduling: API creates, lists, reschedules and clears times; rejects malformed input without writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { store, repo } = setup();
  const app = createApp(store);
  const post = (path: string, body: unknown) => app.request(`/api${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const input = { kind: "maintenance", title: "Scheduled", brief: "Do it", repoId: repo.id, autonomy: "observe" };
    for (const scheduledAt of ["not-a-date", 42, "2030-06-15T13:00", NOW.toISOString()]) {
      assert.equal((await post("/tasks", { ...input, scheduledAt })).status, 400);
    }
    assert.equal(store.listTasks().length, 0);
    const created = await post("/tasks", { ...input, scheduledAt: "2030-06-15T09:00-04:00" });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal(task.scheduledAt, DUE);
    assert.equal((await (await app.request(`/api/tasks/${task.id}`)).json()).task.scheduledAt, DUE);
    assert.equal((await (await app.request("/api/tasks")).json())[0].scheduledAt, DUE);
    const events = store.listEvents(task.id);
    for (const body of [null, [], {}, "text", { scheduledAt: 42 }, { scheduledAt: "" }]) {
      assert.equal((await post(`/tasks/${task.id}/schedule`, body)).status, 400);
      assert.equal(store.getTask(task.id)!.scheduledAt, DUE);
      assert.deepEqual(store.listEvents(task.id), events);
    }
    const later = "2030-06-15T14:00:00.000Z";
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: later })).status, 200);
    assert.equal(store.getTask(task.id)!.scheduledAt, later);
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: null })).status, 200);
    assert.equal(store.claimNextTask("a-jib")?.id, task.id);
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: DUE })).status, 400);
  } finally { store.close(); }
});

test("scheduling: factory workers run other work, hold future work, and honor pause when it becomes due", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dir = mkdtempSync(join(tmpdir(), "crane-scheduled-factory-"));
  const previousHome = process.env.CRANE_HOME;
  process.env.CRANE_HOME = dir;
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: process.cwd() });
  const actions = new OperatorActions(store);
  const input: NewTask = { kind: "maintenance", title: "Scheduled", brief: "", repoId: repo.id, autonomy: "observe" };
  const future = actions.createTask({ ...input, scheduledAt: DUE });
  const immediate = actions.createTask({ ...input, title: "Now" });
  const seen: string[] = [];
  const driver: AgentDriver = {
    name: "test", label: "Test", available: async () => true,
    run: async (ctx) => {
      seen.push(ctx.task.id);
      return { report: { summary: "Done", findings: [], changedFiles: [] } };
    },
  };
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10 });
  t.after(async () => {
    await factory.stop();
    store.close();
    if (previousHome === undefined) delete process.env.CRANE_HOME;
    else process.env.CRANE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ok(), "factory reached the expected state");
  };
  factory.start();
  await until(() => store.getTask(immediate.id)!.status === "done");
  assert.deepEqual(seen, [immediate.id]);
  assert.equal(store.getTask(future.id)!.status, "queued");
  actions.pause();
  t.mock.timers.setTime(Date.parse(DUE));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.getTask(future.id)!.status, "queued", "due work waits while paused");
  actions.resume();
  await until(() => store.getTask(future.id)!.status === "done");
  assert.deepEqual(seen, [immediate.id, future.id]);
});
