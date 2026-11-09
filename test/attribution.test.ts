import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actorLabel, eventActor, isEventActor, type EventActor, type GoalPlan, type TaskEvent } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { hostActor, withActor } from "@crane/backend-runtime";
import { OperatorActions } from "../src/factory/actions.js";
import { runCli } from "../src/cli/program.js";
import { eventLine } from "../src/cli/ui.js";
import { createApp } from "../src/server/app.js";

/**
 * With several operators, history says who did what: operator events carry a
 * snapshot of the actor who made them, and tasks record who started them.
 */

const HOST: EventActor = { kind: "host", name: "ahmed" };
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo", name: "app" });
  await actions.addOperator(HOST, { username: "admin", name: "Admin", role: "admin", password: "correct horse battery" });
  const profile = await actions.addOperator(HOST, { username: "sam", name: "Sam", role: "operator", password: "correct horse battery" });
  const sam: EventActor = { kind: "operator", id: profile.id, name: profile.name };
  /** A task waiting for review, with no branch, so a decision needs no git. */
  const reviewable = (title = "Review me") => {
    const t = store.createTask({ kind: "maintenance", title, brief: "", repoId: repo.id, autonomy: "propose" });
    store.updateTask(t.id, { status: "needs_review" });
    return t.id;
  };
  return { store, actions, repo, sam, reviewable };
}

const decision = (store: Store, id: string, message: RegExp): TaskEvent => {
  const event = store.listEvents(id).find((e) => e.type === "operator" && message.test(e.message));
  assert.ok(event, `no operator event matching ${message}`);
  return event;
};

test("attribution: approve, decline and goal approval record the signed-in operator", async () => {
  const { store, actions, repo, sam, reviewable } = await setup();
  const kai: EventActor = { kind: "operator", id: "op-kai", name: "Kai" };
  const approved = reviewable();
  await withActor(sam, () => actions.approve(approved));
  assert.deepEqual(eventActor(decision(store, approved, /^Approved/)), sam);
  const declined = reviewable();
  await withActor(kai, () => actions.reject(declined));
  assert.deepEqual(eventActor(decision(store, declined, /^Declined/)), kai);

  const goal = actions.createGoal({ repoId: repo.id, outcome: "Saved carts", driver: "simulated" });
  const plan: GoalPlan = { summary: "One change", approach: "Just one", improvements: [], tasks: [{ key: "one", title: "Do it", brief: "Do the one thing",
    dependsOn: [], driver: "simulated", model: null, effort: null, rationale: "Only task", acceptance: ["It is done"] }] };
  store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Planned", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Planned", evidence: "Read it" }, goalPlan: plan } });
  store.syncGoals();
  withActor(sam, () => actions.approveGoal(goal.id, store.getGoal(goal.id)!.revision));
  assert.deepEqual(eventActor(decision(store, goal.researchTaskId, /^Approved goal plan/)), sam);
  store.close();
});

test("attribution: the API and CLI show the actor on operator events; nothing when there is none", async () => {
  const { store, actions, sam, reviewable } = await setup();
  const id = reviewable();
  await withActor(sam, () => actions.approve(id));
  const approvedLine = plain(eventLine(decision(store, id, /^Approved/)));
  assert.match(approvedLine, /Approved · Sam$/);

  const unattributed = reviewable("By nobody");
  await actions.approve(unattributed);
  const event = decision(store, unattributed, /^Approved/);
  assert.equal(event.data?.actor, undefined, "no actor key is stored without an actor");
  assert.equal(eventActor(event), null);
  assert.match(plain(eventLine(event)), /Approved$/);
  store.close();
});

test("attribution: task detail over the API carries the starter and each decision's actor", async () => {
  // No operators on loopback, so no sign-in: the gate is tested with the API's auth.
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo", name: "app" });
  const sam: EventActor = { kind: "operator", id: "op-sam", name: "Sam" };
  const task = withActor(sam, () => actions.createTask({ kind: "maintenance", title: "Mine", brief: "Mine", repoId: repo.id, autonomy: "propose" }));
  store.updateTask(task.id, { status: "needs_review" });
  await withActor(sam, () => actions.approve(task.id));
  const res = await createApp(store).request(`/api/tasks/${task.id}`, { headers: { host: "localhost:4471" } });
  assert.equal(res.status, 200);
  const body = await res.json() as { task: { createdBy: EventActor | null }; events: TaskEvent[] };
  assert.deepEqual(body.task.createdBy, sam);
  assert.deepEqual(eventActor(body.events.find((e) => e.message === "Approved")!), sam);
  const list = await createApp(store).request("/api/tasks", { headers: { host: "localhost:4471" } });
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /createdBy/);
  store.close();
});

test("attribution: an explicit actor in the event data is kept, and only operator events are stamped", async () => {
  const { store, sam, reviewable } = await setup();
  const id = reviewable();
  const other: EventActor = { kind: "operator", id: "op-x", name: "Other" };
  withActor(sam, () => {
    store.addEvent(id, "operator", "Given", { actor: other });
    store.addEvent(id, "note", "A note");
  });
  assert.deepEqual(eventActor(decision(store, id, /^Given/)), other);
  assert.equal(store.listEvents(id).find((e) => e.message === "A note")!.data, null);
  store.close();
});

test("attribution: decisions made from the CLI are attributed to the host", async () => {
  const { store, reviewable } = await setup();
  const id = reviewable();
  const { log, error } = console;
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(plain(a.join(" ")));
  console.error = () => {};
  try {
    await runCli(["node", "crane", "approve", id], store);
    await runCli(["node", "crane", "show", id], store);
  } finally {
    console.log = log;
    console.error = error;
  }
  const host = hostActor();
  assert.equal(host.kind, "host");
  assert.ok(host.name.length > 0);
  assert.deepEqual(eventActor(decision(store, id, /^Approved/)), host);
  assert.match(out.join("\n"), new RegExp(`Approved · ${actorLabel(host)}`));
  store.close();
});

test("attribution: tasks record and show who started them; schedules and the factory start none", async () => {
  const { store, actions, repo, sam } = await setup();
  const started = withActor(sam, () => actions.createTask({ kind: "maintenance", title: "Mine", brief: "Mine", repoId: repo.id, autonomy: "observe" }));
  assert.deepEqual(store.getTask(started.id)!.createdBy, sam);
  const factory = store.createTask({ kind: "maintenance", title: "Nobody's", brief: "", repoId: repo.id, autonomy: "observe" });
  assert.equal(store.getTask(factory.id)!.createdBy, null);
  // A schedule starts its runs even when it fires inside someone's context.
  const scheduled = withActor(sam, () => store.createTask({ kind: "maintenance", title: "Scheduled", brief: "", repoId: repo.id, autonomy: "observe", scheduleId: "cs-1" }));
  assert.equal(store.getTask(scheduled.id)!.createdBy, null);

  const out: string[] = [];
  const { log } = console;
  console.log = (...a: unknown[]) => void out.push(plain(a.join(" ")));
  try {
    await runCli(["node", "crane", "show", started.id], store);
    await runCli(["node", "crane", "show", factory.id], store);
  } finally {
    console.log = log;
  }
  const [mine, nobodys] = [out.findIndex((l) => l.includes("Mine")), out.findIndex((l) => l.includes("Nobody's"))];
  assert.match(out.slice(mine, nobodys).join("\n"), /Started by Sam/);
  assert.doesNotMatch(out.slice(nobodys).join("\n"), /Started by/);
  store.close();
});

test("attribution: task-list summaries leave out createdBy", async () => {
  const { store, actions, repo, sam } = await setup();
  withActor(sam, () => actions.createTask({ kind: "maintenance", title: "Mine", brief: "Mine", repoId: repo.id, autonomy: "observe" }));
  const [summary] = store.listTaskSummaries();
  assert.ok(summary);
  assert.equal("createdBy" in summary, false);
  assert.deepEqual(store.listTasks()[0]!.createdBy, sam);
  store.close();
});

test("attribution: an event keeps its recorded name after the operator is renamed or removed", async () => {
  const { store, actions, sam, reviewable } = await setup();
  const id = reviewable();
  const task = withActor(sam, () => store.createTask({ kind: "maintenance", title: "Sam's", brief: "", repoId: null, autonomy: "observe" }));
  await withActor(sam, () => actions.approve(id));
  assert.ok(store.access.setName(sam.id, "Samantha"));
  assert.equal(eventActor(decision(store, id, /^Approved/))?.name, "Sam");
  actions.removeOperator(HOST, sam.id);
  assert.equal(actions.listOperators().some((o) => o.id === sam.id), false);
  assert.deepEqual(eventActor(decision(store, id, /^Approved/)), sam);
  assert.deepEqual(store.getTask(task.id)!.createdBy, sam);
  store.close();
});

test("attribution: an older database gains tasks.created_by through migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-attribution-"));
  try {
    const file = join(dir, "old.db");
    const old = new Database(file);
    old.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, repo_id TEXT,
      autonomy TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, branch TEXT, worktree TEXT, report TEXT,
      cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`);
    old.prepare("INSERT INTO tasks(id, kind, title, brief, autonomy, status, created_at) VALUES('t-old', 'maintenance', 'Old', '', 'observe', 'done', '')").run();
    old.close();
    const store = new Store(file);
    assert.equal(store.getTask("t-old")!.createdBy, null);
    const fresh = withActor(HOST, () => store.createTask({ kind: "maintenance", title: "New", brief: "", repoId: null, autonomy: "observe" }));
    assert.deepEqual(store.getTask(fresh.id)!.createdBy, HOST);
    store.close();
    const check = new Database(file, { readonly: true });
    const columns = (check.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    check.close();
    assert.ok(columns.includes("created_by"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attribution: eventActor and isEventActor reject malformed data", () => {
  const event = (data: Record<string, unknown> | null): TaskEvent => ({ id: 1, taskId: "t-1", ts: "", type: "operator", message: "Approved", data });
  for (const actor of [undefined, null, "Sam", 3, [], {}, { kind: "operator", name: "Sam" }, { kind: "operator", id: "", name: "Sam" },
    { kind: "operator", id: "op-1", name: "" }, { kind: "operator", id: "op-1", name: "  " }, { kind: "host" }, { kind: "host", name: 7 },
    { kind: "robot", name: "R2" }, { kind: "operator", id: 5, name: "Sam" }]) {
    assert.equal(eventActor(event({ actor })), null, JSON.stringify(actor));
  }
  assert.equal(eventActor(event(null)), null);
  assert.equal(isEventActor({ kind: "host", name: "ahmed" }), true);
  assert.deepEqual(eventActor(event({ actor: { kind: "operator", id: "op-1", name: "Sam" } })), { kind: "operator", id: "op-1", name: "Sam" });
});
