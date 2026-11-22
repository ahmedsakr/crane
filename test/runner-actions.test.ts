import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withActor } from "@crane/backend-runtime";
import type { EventActor, NewTask } from "@crane/contracts";
import { AccessError, OperatorActions } from "@crane/factory/actions";
import { Store } from "@crane/storage";
import { plan, researchResult } from "./support/goal-fixture.js";

const HOST: EventActor = { kind: "host", name: "crane" };
const AT = "2026-11-21T12:00:00.000Z";
const FORBIDDEN = { name: AccessError.name, status: 403 };

function setup(t: TestContext) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  let now = Date.parse(AT);
  const actions = new OperatorActions(store, () => now);
  const operator = (username: string, role: "admin" | "operator" = "operator") => {
    const { id, name } = store.access.createOperator({ username, name: username, role, passwordHash: "unused", at: AT });
    return { kind: "operator" as const, id, name };
  };
  const owner = operator("robin");
  const other = operator("sam");
  const admin = operator("alex", "admin");
  const repo = store.addRepo({ path: "/repo" });
  const input: NewTask = { kind: "repo_feature", title: "Build it", brief: "Do the work", repoId: repo.id, autonomy: "propose" };
  return { store, actions, owner, other, admin, input, advance: (ms: number) => { now += ms; } };
}

test("runner actions: owners manage their own containers, admins manage all, and only the host can register for another operator", (t) => {
  const { actions, owner, other, admin } = setup(t);
  const { runner } = actions.addRunner(owner, { name: "  Laptop  ", capacity: 2 });
  const hosted = actions.addRunner(HOST, { name: "Desktop", operator: " SAM " }).runner;
  assert.equal(runner.ownerId, owner.id);
  assert.equal(runner.name, "Laptop");
  assert.equal(hosted.ownerId, other.id);
  assert.equal(hosted.capacity, 1);
  for (const by of [other, admin]) {
    assert.throws(() => actions.addRunner(by, { name: "For Robin", operator: "robin" }), FORBIDDEN);
  }
  assert.deepEqual(actions.listRunners(owner), [runner]);
  assert.deepEqual(actions.listRunners(other), [hosted]);
  for (const by of [admin, HOST]) assert.deepEqual(actions.listRunners(by), [runner, hosted]);
  assert.throws(() => actions.renameRunner(other, runner.id, "Mine"), FORBIDDEN);
  assert.throws(() => actions.rotateRunnerToken(other, runner.id), FORBIDDEN);
  assert.throws(() => actions.setRunnerCapacity(other, runner.id, 4), FORBIDDEN);
  assert.throws(() => actions.removeRunner(other, runner.id), FORBIDDEN);
  assert.equal(actions.renameRunner(owner, runner.id, "Travel laptop").name, "Travel laptop");
  assert.equal(actions.renameRunner(admin, runner.id, "Studio").name, "Studio");
  assert.equal(actions.setRunnerCapacity(admin, runner.id, 8).capacity, 8);
  assert.equal(actions.rotateRunnerToken(owner, runner.id).runner.id, runner.id);
  assert.equal(actions.rotateRunnerToken(admin, runner.id).runner.id, runner.id);
  actions.removeRunner(owner, runner.id);
  actions.removeRunner(admin, hosted.id);
  assert.deepEqual(actions.listRunners(HOST), []);
});

test("runner actions: tokens are issued once, persisted as digests, and only valid until rotation or revocation", (t) => {
  const { actions, store, owner, advance } = setup(t);
  const first = actions.addRunner(owner, { name: "Laptop" });
  const { id } = first.runner;
  const row = () => store.db.prepare("SELECT * FROM runners WHERE id = ?").get(id) as { token_hash: string };
  const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(row().token_hash, digest(first.token));
  assert.equal(first.runner.lastSeenAt, null);
  assert.equal(actions.authenticateRunner(first.token)?.lastSeenAt, AT);
  advance(1000);
  const rotated = actions.rotateRunnerToken(owner, id);
  assert.notEqual(rotated.token, first.token);
  assert.equal(row().token_hash, digest(rotated.token));
  assert.equal(actions.authenticateRunner(first.token), null);
  assert.equal(actions.authenticateRunner("a".repeat(43)), null);
  assert.equal(actions.authenticateRunner(123), null);
  const authenticated = actions.authenticateRunner(rotated.token)!;
  assert.equal(authenticated.id, id);
  assert.equal(authenticated.lastSeenAt, "2026-11-21T12:00:01.000Z");
  assert.equal(actions.listRunners(owner)[0]?.lastSeenAt, authenticated.lastSeenAt);
  actions.renameRunner(owner, id, "Studio");
  actions.setRunnerCapacity(owner, id, 3);
  actions.removeRunner(owner, id);
  assert.equal(actions.authenticateRunner(rotated.token), null);
  const events = store.db.prepare("SELECT type, runner_id, message, actor FROM runner_events ORDER BY id").all();
  assert.deepEqual(events, ["Added container", "Rotated container token", "Renamed container from Laptop to Studio",
    "Set container capacity to 3", "Removed container"].map((message) => ({ type: "operator", runner_id: id, message, actor: JSON.stringify(owner) })));
  const records = JSON.stringify([row(), first.runner, rotated.runner, authenticated, actions.listRunners(owner), events]);
  for (const token of [first.token, rotated.token]) assert.ok(!records.includes(token));
  for (const result of [first.runner, rotated.runner, authenticated]) assert.doesNotMatch(JSON.stringify(result), /token|hash/i);
});

test("runner actions: validate container names, capacities, and operator names before saving", (t) => {
  const { actions, owner } = setup(t);
  for (const name of ["", "x".repeat(61), "a\nb"]) assert.throws(() => actions.addRunner(owner, { name }), /Enter a name/);
  assert.throws(() => actions.addRunner(HOST, { name: "Laptop", operator: "unknown" }), /Choose an existing operator/);
  const { runner } = actions.addRunner(owner, { name: "Laptop", capacity: 1 });
  for (const capacity of [0, 9, 1.5, "2", null]) {
    assert.throws(() => actions.setRunnerCapacity(owner, runner.id, capacity), /Choose a container capacity from 1 to 8/);
    assert.throws(() => actions.addRunner(owner, { name: "Laptop", capacity }), /Choose a container capacity from 1 to 8/);
  }
  assert.deepEqual(actions.listRunners(owner), [runner]);
});

test("runner actions: only the owner can route to a container, even for admins or host, and claims prevent rerouting", (t) => {
  const { store, actions, input, owner, other, admin } = setup(t);
  const { runner } = actions.addRunner(owner, { name: "Laptop" });
  const next = actions.addRunner(owner, { name: "Spare" }).runner;
  const task = actions.createTask(input);
  for (const by of [other, admin, HOST]) assert.throws(() => actions.setTaskRunner(by, task.id, runner.id), FORBIDDEN);
  assert.throws(() => actions.setTaskRunner(owner, task.id, "c-missing"), /Choose a registered container/);
  assert.throws(() => actions.setTaskRunner(owner, task.id, ""), /Choose a container/);
  assert.throws(() => withActor(other, () => actions.createTask({ ...input, runnerId: runner.id })), FORBIDDEN);
  store.updateTask(task.id, { sessionId: "previous session" });
  const changed = withActor(owner, () => actions.changeAgent(task.id, { driver: "codex", runnerId: runner.id }));
  assert.deepEqual([changed.runnerId, changed.driver, changed.sessionId], [runner.id, "codex", null]);
  assert.deepEqual(store.listEvents(task.id).find((e) => e.message === "Changed container to Laptop")?.data, { runnerId: runner.id, actor: owner });
  assert.throws(() => actions.setTaskRunner(other, task.id, null), FORBIDDEN);
  assert.equal(actions.setTaskRunner(owner, task.id, null).runnerId, null);
  assert.equal(actions.setTaskRunner(owner, task.id, runner.id).runnerId, runner.id);
  assert.equal(store.claimNextRunnerTask(runner.id, "remote")?.id, task.id);
  assert.throws(() => actions.setTaskRunner(owner, task.id, next.id), /stop running or merging/);
  assert.equal(store.getTask(task.id)?.runnerId, runner.id);
});

test("runner actions: operator defaults apply to regular tasks, goal research, revisions and approved plan tasks", (t) => {
  const { store, actions, owner, other, input } = setup(t);
  const { runner } = actions.addRunner(owner, { name: "Laptop" });
  const next = actions.addRunner(owner, { name: "Spare" }).runner;
  assert.throws(() => actions.setDefaultRunner(other, runner.id), FORBIDDEN);
  assert.equal(actions.setDefaultRunner(owner, runner.id), runner.id);
  assert.equal(store.getSetting(`runners.default.${owner.id}`), runner.id);
  assert.equal(withActor(owner, () => actions.createTask(input)).runnerId, runner.id);
  assert.equal(withActor(other, () => actions.createTask(input)).runnerId, null);
  assert.equal(withActor(owner, () => actions.createTask({ ...input, runnerId: null })).runnerId, null);
  const goal = withActor(owner, () => actions.createGoal({ outcome: "Save carts", repoId: input.repoId! }));
  assert.equal(store.getTask(goal.researchTaskId)?.runnerId, runner.id);
  const researched = researchResult(store, goal);
  actions.setDefaultRunner(owner, next.id);
  const revised = withActor(owner, () => actions.reviseGoal(goal.id, researched.revision, "Keep the current cart API"));
  assert.equal(store.getTask(revised.researchTaskId)?.runnerId, next.id);
  const edited = researchResult(store, revised, { goalPlan: plan() });
  const approved = withActor(owner, () => actions.approveGoal(goal.id, edited.revision));
  assert.ok(approved.tasks.length > 0);
  assert.ok(approved.tasks.every(({ taskId }) => store.getTask(taskId)?.runnerId === next.id));
});

test("runner actions: post-mortems, retries, follow-ups and scheduled runs retain their source route", async (t) => {
  const { store, actions, owner, other, input } = setup(t);
  const { runner } = actions.addRunner(owner, { name: "Laptop" });
  const next = actions.addRunner(owner, { name: "Spare" }).runner;
  const task = withActor(owner, () => actions.createTask({ ...input, runnerId: runner.id }));
  actions.setDefaultRunner(owner, next.id);
  store.updateTask(task.id, { status: "merging", report: { summary: "Ready", changedFiles: [], findings: [
    { title: "Follow up", detail: "Inspect results", impact: "low", effort: "small" },
  ] } });
  assert.equal(store.completeMerge(task.id, "Merged", {})?.runnerId, runner.id);
  assert.equal(withActor(owner, () => actions.retry(task.id)).runnerId, runner.id);
  assert.equal(withActor(owner, () => actions.followUp(task.id, 0)).runnerId, runner.id);
  assert.throws(() => withActor(other, () => actions.retry(task.id)), FORBIDDEN);
  assert.throws(() => withActor(other, () => actions.followUp(task.id, 0)), FORBIDDEN);
  store.upsertAgent({ id: "a-tests", name: "Tests", driver: "simulated" });
  store.setSetting("crew_role_a-tests", "tests");
  const policy = { repoId: input.repoId!, daysMask: 127, timezone: "UTC", localTime: "08:00", enabled: true, preApprove: false };
  assert.throws(() => withActor(other, () => actions.saveCrewSchedule("a-tests", { ...policy, runnerId: runner.id })), FORBIDDEN);
  const created = withActor(owner, () => actions.saveCrewSchedule("a-tests", { ...policy, runnerId: runner.id }));
  assert.throws(() => withActor(other, () => actions.saveCrewSchedule("a-tests", policy, created.id)), FORBIDDEN);
  const schedule = withActor(owner, () => actions.saveCrewSchedule("a-tests", policy, created.id));
  assert.equal(schedule.runnerId, runner.id);
  await assert.rejects(withActor(other, () => actions.runRole("a-tests", { repoId: input.repoId!, scheduleId: schedule.id })), FORBIDDEN);
  actions.fireCrewSchedules(Date.parse(schedule.nextFireAt));
  const run = store.listTasks({ assignee: "a-tests" })[0];
  assert.equal(run?.scheduleId, schedule.id);
  assert.equal(run?.runnerId, runner.id);
});

test("runner actions: requiring containers refuses missing routes for operator tasks and goals, while host work is exempt", (t) => {
  const { actions, store, input, owner, admin } = setup(t);
  assert.equal(actions.runnersRequired(), "off");
  assert.equal(withActor(owner, () => actions.createTask(input)).runnerId, null);
  assert.throws(() => actions.setRunnersRequired(owner, "on"), FORBIDDEN);
  assert.throws(() => actions.setRunnersRequired(admin, true), /Choose whether containers are required/);
  assert.equal(actions.setRunnersRequired(admin, "on"), "on");
  assert.equal(store.getSetting("runners.required"), "on");
  const required = { ...FORBIDDEN, message: "Add a container from Account → Containers, then try again" };
  assert.throws(() => withActor(owner, () => actions.createTask(input)), required);
  assert.throws(() => withActor(owner, () => actions.createGoal({ outcome: "Save carts", repoId: input.repoId! })), required);
  assert.equal(withActor(HOST, () => actions.createTask(input)).runnerId, null);
  const { runner } = actions.addRunner(owner, { name: "Laptop" });
  const task = withActor(owner, () => actions.createTask({ ...input, runnerId: runner.id }));
  assert.throws(() => actions.setTaskRunner(owner, task.id, null), required);
  assert.equal(actions.setDefaultRunner(owner, runner.id), runner.id);
  assert.equal(withActor(owner, () => actions.createTask(input)).runnerId, runner.id);
  actions.removeRunner(owner, runner.id);
  assert.throws(() => withActor(owner, () => actions.createTask(input)), required);
});

test("runner actions: removal cancels open jobs and requeues running work with a note and no local fallback", (t) => {
  const { actions, store, input, owner, admin } = setup(t);
  const { runner } = actions.addRunner(owner, { name: "Laptop" });
  actions.setDefaultRunner(owner, runner.id);
  const task = withActor(owner, () => actions.createTask(input));
  const waiting = withActor(owner, () => actions.createTask(input));
  assert.equal(store.claimNextRunnerTask(runner.id, "remote")?.id, task.id);
  const addJob = (taskId: string) => store.runners.createJob({ runnerId: runner.id, taskId, kind: "work", payload: {}, at: AT });
  const claimed = addJob(task.id);
  assert.equal(store.runners.claimJob(runner.id, AT)?.id, claimed.id);
  const queued = addJob(waiting.id);
  const finished = addJob(task.id);
  store.runners.finishJob(finished.id, "returned", null, AT);
  actions.removeRunner(admin, runner.id);
  for (const { id } of [claimed, queued]) assert.equal(store.runners.job(id)?.state, "cancelled");
  assert.equal(store.runners.job(finished.id)?.state, "returned");
  assert.equal(actions.defaultRunner(owner), null);
  assert.equal(store.getTask(waiting.id)?.status, "queued");
  const requeued = store.getTask(task.id)!;
  assert.deepEqual([requeued.status, requeued.agentId, requeued.runnerId], ["queued", null, runner.id]);
  assert.ok(store.listEvents(task.id).some((e) => e.type === "note" && /container was removed/.test(e.message)));
  assert.equal(store.claimNextRunnerTask(runner.id, "remote"), null);
  assert.equal(store.claimNextTask("crew"), null);
  const replacement = actions.addRunner(owner, { name: "Spare" }).runner;
  assert.equal(actions.setTaskRunner(owner, task.id, replacement.id).runnerId, replacement.id);
  assert.equal(store.claimNextRunnerTask(replacement.id, "remote")?.id, task.id);
});
