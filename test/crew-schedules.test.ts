import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCrewFire, type CrewScheduleInput } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { Factory } from "../src/factory/orchestrator.js";
import { SimulatedDriver } from "../src/agents/simulated.js";

const policy: CrewScheduleInput = {
  repoId: "r-test", daysMask: 62, localTime: "09:00", timezone: "America/Toronto", preApprove: true, enabled: true,
};
const monday = Date.parse("2030-06-17T13:00:00Z");

function setup(file = ":memory:") {
  const store = new Store(file);
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd(), name: "crane", isFactory: true });
  store.upsertAgent({ id: "a-tests", name: "Tests", driver: "simulated" });
  store.setSetting("crew_role_a-tests", "tests");
  const input = { ...policy, repoId: repo.id };
  return { store, actions, repo, input };
}

test("crew schedules: wall clock survives DST, spring gaps skip and folds fire only once", () => {
  const next = (after: string, extra: Partial<CrewScheduleInput> = {}) => nextCrewFire({ ...policy, ...extra }, Date.parse(after));
  assert.equal(next("2030-03-08T14:00:00Z"), "2030-03-11T13:00:00.000Z");
  assert.equal(next("2030-11-01T13:00:00Z"), "2030-11-04T14:00:00.000Z");
  assert.equal(next("2030-03-09T12:00:00Z", { daysMask: 1, localTime: "02:30" }), "2030-03-17T06:30:00.000Z");
  const fold = { daysMask: 1, localTime: "01:30" };
  assert.equal(next("2030-11-02T12:00:00Z", fold), "2030-11-03T05:30:00.000Z");
  assert.equal(next("2030-11-03T05:30:00Z", fold), "2030-11-10T06:30:00.000Z");
  assert.equal(next("2030-11-03T05:45:00Z", fold), "2030-11-10T06:30:00.000Z");
  assert.equal(next("2030-06-17T03:00:00Z", { timezone: "Asia/Kolkata" }), "2030-06-17T03:30:00.000Z");
  assert.equal(next("2030-06-17T03:30:00Z", { timezone: "Asia/Kolkata" }), "2030-06-18T03:30:00.000Z");
  assert.equal(next("2030-06-17T22:00:00Z", { timezone: "Pacific/Auckland" }), "2030-06-18T21:00:00.000Z");
});

test("crew schedules: validate before writes; CRUD, ownership, and paused schedules", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  const { store, actions, input } = setup();
  try {
    for (const patch of [{ daysMask: 0 }, { daysMask: 128 }, { daysMask: 1.5 }, { localTime: "9:00" },
      { localTime: "24:00" }, { timezone: "not/a-zone" }, { preApprove: "true" }, { enabled: 1 }, { repoId: "missing" }]) {
      assert.throws(() => actions.saveCrewSchedule("a-tests", { ...input, ...patch } as CrewScheduleInput));
    }
    assert.throws(() => actions.saveCrewSchedule("a-missing", input), /No crew member/);
    assert.equal(actions.listCrewSchedules().length, 0);
    let s = actions.saveCrewSchedule("a-tests", input);
    assert.equal(s.nextFireAt, new Date(monday).toISOString());
    s = actions.saveCrewSchedule("a-tests", { ...s, enabled: false }, s.id);
    actions.fireCrewSchedules(monday);
    assert.equal(store.listTasks().length, 0);
    assert.equal(actions.listCrewSchedules()[0]!.lastFiredAt, null);
    store.upsertAgent({ id: "a-other", name: "Other", driver: "simulated" });
    store.setSetting("crew_role_a-other", "tests");
    assert.throws(() => actions.removeCrewSchedule("a-other", s.id), /No such/);
    assert.throws(() => actions.saveCrewSchedule("a-other", input, s.id), /No such/);
    actions.removeCrewSchedule("a-tests", s.id);
    assert.equal(actions.listCrewSchedules().length, 0);
    store.setSetting("crew_role_a-tests", "security");
    assert.throws(() => actions.saveCrewSchedule("a-tests", input), /cannot be pre-approved/);
  } finally { store.close(); }
});

test("crew schedules: exact slot, pre-approval, origin survives removal, and catch-up happens once", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  const { store, actions, input, repo } = setup();
  try {
    const s = actions.saveCrewSchedule("a-tests", input);
    actions.fireCrewSchedules(monday - 1);
    assert.equal(store.listTasks().length, 0);
    t.mock.timers.setTime(monday);
    actions.fireCrewSchedules();
    const task = store.listTasks()[0]!;
    assert.equal(task.repoId, repo.id);
    assert.equal(task.assignee, "a-tests");
    assert.equal(task.scheduleId, s.id);
    assert.equal(task.preApprovedAt, new Date(monday).toISOString());
    assert.ok(store.listEvents(task.id).some((e) => e.data?.scheduleId === s.id && /Tests's weekday 09:00/.test(e.message)));
    actions.fireCrewSchedules();
    assert.equal(store.listTasks().length, 1);
    store.setStatus(task.id, "done");
    actions.saveCrewSchedule("a-tests", { ...input, preApprove: false }, s.id);
    t.mock.timers.setTime(monday + 14 * 86_400_000);
    actions.fireCrewSchedules();
    assert.equal(store.listTasks().length, 2, "one catch-up, not every missed weekday");
    assert.equal(store.listTasks().find((t) => t.id !== task.id)!.preApprovedAt, null, "editing pre-approval affects future runs");
    assert.ok(store.getTask(task.id)!.preApprovedAt, "existing consent is retained on the original run");
    assert.ok(Date.parse(actions.listCrewSchedules()[0]!.nextFireAt) > Date.now());
    actions.fireCrewSchedules();
    assert.equal(store.listTasks().length, 2);
    actions.removeCrewSchedule("a-tests", s.id);
    assert.equal(store.getTask(task.id)!.scheduleId, s.id);
  } finally { store.close(); }
});

test("crew schedules: on-call, paused, open runs, missing role and invalid pre-approval skip with a reason", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  for (const reason of ["on-call", "paused", "factory paused", "open", "role", "pre-approval"] as const) {
    const { store, actions, input } = setup();
    try {
      actions.saveCrewSchedule("a-tests", input);
      if (reason === "on-call") store.setSetting("crew_active_a-tests", "false");
      if (reason === "paused") store.setAgentState("a-tests", "paused", null);
      if (reason === "factory paused") store.setPaused(true);
      if (reason === "role") store.setSetting("crew_role_a-tests", "");
      if (reason === "pre-approval") store.setSetting("crew_role_a-tests", "security");
      if (reason === "open") {
        const task = await actions.runRole("a-tests", { repoId: input.repoId });
        store.setStatus(task.id, "needs_review");
        // A member's open run must be found beyond listTasks' default preview.
        for (let i = 0; i < 205; i++) store.createTask({ kind: "maintenance", title: "Other", brief: "", repoId: input.repoId, autonomy: "observe" });
      }
      const count = store.listTasks({ limit: -1 }).length;
      actions.fireCrewSchedules(monday);
      assert.equal(store.listTasks({ limit: -1 }).length, count, reason);
      const saved = actions.listCrewSchedules()[0]!;
      assert.match(saved.lastOutcome!, /^Skipped:/, reason);
      assert.match(saved.lastOutcome!, reason === "open" ? /already has/ : reason === "role" ? /no maintenance role/ : reason === "pre-approval" ? /nothing to merge/ : reason === "factory paused" ? /paused/ : new RegExp(reason));
      assert.ok(Date.parse(saved.nextFireAt) > monday);
      assert.equal(saved.lastFiredAt, new Date(monday).toISOString());
    } finally { store.close(); }
  }
});

test("crew schedules: persistent slots are claimed once across store connections, with transactional rollback", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  const dir = mkdtempSync(join(tmpdir(), "crane-crew-schedules-"));
  const file = join(dir, "crane.db");
  let { store, actions, input } = setup(file);
  try {
    const s = actions.saveCrewSchedule("a-tests", input);
    store.close();
    store = new Store(file);
    actions = new OperatorActions(store);
    const other = new Store(file);
    try {
      assert.equal(other.listCrewSchedules()[0]!.id, s.id);
      assert.throws(() => store.db.transaction(() => {
        assert.equal(store.claimCrewSchedule(s, nextCrewFire(s, monday), new Date(monday).toISOString()), true);
        throw new Error("crash");
      }).immediate(), /crash/);
      assert.equal(store.listCrewSchedules()[0]!.nextFireAt, s.nextFireAt);
      actions.fireCrewSchedules(monday);
      assert.equal(other.claimCrewSchedule(s, nextCrewFire(s, monday), new Date(monday).toISOString()), false);
      new OperatorActions(other).fireCrewSchedules(monday);
      assert.equal(other.listTasks().length, 1);
      assert.equal(other.listCrewSchedules()[0]!.lastOutcome, `Queued ${other.listTasks()[0]!.id}`);
    } finally { other.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("crew schedules: API CRUD validates input and ownership without sockets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  const { store, input } = setup();
  const app = createApp(store);
  const base = "/api/agents/a-tests/schedules";
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const bad of [null, {}, [], { ...input, preApprove: "yes" }, { ...input, daysMask: 0 }]) assert.equal((await post(base, bad)).status, 400);
    const created = await post(base, input);
    assert.equal(created.status, 201);
    const s = await created.json();
    assert.equal((await (await app.request(base)).json()).length, 1);
    assert.equal((await post(`${base}/${s.id}`, { ...input, preApprove: false, enabled: false })).status, 200);
    assert.equal(store.listCrewSchedules()[0]!.preApprove, false);
    assert.equal((await post(`${base}/missing`, input)).status, 400);
    assert.equal((await app.request(`${base}/${s.id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.listCrewSchedules().length, 0);
  } finally { store.close(); }
});

test("crew schedules: older task databases gain nullable schedule provenance on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-crew-migration-"));
  const file = join(dir, "crane.db");
  let store = new Store(file);
  try {
    const task = store.createTask({ kind: "maintenance", title: "Old task", brief: "", repoId: null, autonomy: "observe" });
    store.db.exec("ALTER TABLE tasks DROP COLUMN schedule_id");
    store.db.exec("DROP TABLE crew_schedules");
    store.close();
    store = new Store(file);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(store.listCrewSchedules(), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("crew schedules: orchestrator tick skips due runs while paused and prunes retired members' schedules", async (t) => {
  const { store, actions, input } = setup();
  actions.saveCrewSchedule("a-tests", input);
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  store.setSetting("crew_role_a-jib", "tests");
  const s = actions.saveCrewSchedule("a-jib", input);
  store.db.prepare("UPDATE crew_schedules SET next_fire_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", s.id);
  store.setPaused(true);
  const factory = new Factory(store, new SimulatedDriver(1), { crewSize: 1, tickMs: 10 });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  assert.equal(store.listCrewSchedules().length, 1, "retired identities lose their schedules at startup");
  assert.match(store.listCrewSchedules()[0]!.lastOutcome!, /Skipped:.*paused/);
  assert.equal(store.listTasks().length, 0);
});

test("crew schedules: orchestrator tick queues and executes a due maintenance run", async (t) => {
  const { store, actions, input } = setup();
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  store.setSetting("crew_role_a-jib", "security");
  const s = actions.saveCrewSchedule("a-jib", { ...input, preApprove: false });
  store.db.prepare("UPDATE crew_schedules SET next_fire_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", s.id);
  const factory = new Factory(store, new SimulatedDriver(1), { crewSize: 1, tickMs: 10 });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  for (let i = 0; i < 300 && !["done", "needs_review"].includes(store.listTasks()[0]?.status ?? ""); i++) await new Promise((r) => setTimeout(r, 10));
  const task = store.listTasks()[0]!;
  assert.equal(task.status, "needs_review", "the simulated findings await review");
  assert.equal(task.assignee, "a-jib");
  assert.equal(task.agentId, "a-jib");
  assert.equal(task.scheduleId, s.id);
  assert.equal(task.preApprovedAt, null);
  assert.equal(store.listTasks().length, 1);
});
