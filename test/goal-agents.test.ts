import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GOAL_TASK_PHASES, goalProgress, goalTaskPhase, type GoalListItem, type GoalPlan, type TaskStatus } from "@crane/contracts";
import { Store } from "@crane/storage";
import { goalListItems } from "../packages/storage/src/store/goal-progress.js";
import { OperatorActions } from "@crane/factory/actions";
import { createApp } from "../src/server/app.js";

const plan = (): GoalPlan => ({ summary: "Save carts", approach: "Storage first, then the UI", improvements: [], tasks: [
  { key: "storage", title: "Extract storage", brief: "Extract it", dependsOn: [], driver: "codex", model: "gpt-5-codex", effort: "high", rationale: "Refactor first", acceptance: ["Callers keep working"] },
  { key: "ui", title: "Build the UI", brief: "Use storage", dependsOn: ["storage"], driver: "claude-code", model: "sonnet", effort: "high", rationale: "Follows the contract", acceptance: ["Carts reopen"] },
] });

function setup() {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/goals-repo", name: "storefront" });
  const actions = new OperatorActions(store);
  const goal = actions.createGoal({ repoId: repo.id, outcome: "Customers can save carts", driver: "codex", effort: "high" });
  store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Planned", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Done", evidence: "Read the repo" }, goalPlan: plan() } });
  store.syncGoals();
  return { store, repo, actions, goal: store.getGoal(goal.id)! };
}

function approved() {
  const context = setup();
  const goal = context.actions.approveGoal(context.goal.id, context.goal.revision);
  const taskId = (key: string) => goal.tasks.find((t) => t.key === key)!.taskId;
  return { ...context, goal, taskId };
}

const hasEvent = (store: Store, id: string, pattern: RegExp) => store.listEvents(id).some((e) => e.type === "operator" && pattern.test(e.message));

/** What a post-mortem captures when it's queued, which no operator action sets. */
const captureSettings = (store: Store, id: string) =>
  store.db.prepare("UPDATE tasks SET driver_settings = ? WHERE id = ?").run(JSON.stringify({ model: "captured", effort: "low" }), id);

test("change agent: a queued task keeps what's left out, and a new agent clears the old model and effort", () => {
  const { store, actions, taskId } = approved();
  const id = taskId("ui");
  assert.deepEqual(pick(actions.changeAgent(id, { model: "opus" })), { driver: "claude-code", model: "opus", effort: "high" });
  assert.deepEqual(pick(actions.changeAgent(id, { driver: "codex" })), { driver: "codex", model: null, effort: null });
  assert.deepEqual(pick(actions.changeAgent(id, { driver: "codex", model: "gpt-5-codex", effort: "low" })), { driver: "codex", model: "gpt-5-codex", effort: "low" });
  assert.deepEqual(pick(actions.changeAgent(id, { model: "default", effort: null })), { driver: "codex", model: null, effort: null });
  assert.deepEqual(pick(actions.changeAgent(id, { driver: "default" })), { driver: null, model: null, effort: null });
  assert.ok(hasEvent(store, id, /Changed agent to Codex \(gpt-5-codex · low effort\)/));
});

const pick = ({ driver, model, effort }: { driver: string | null; model: string | null; effort: string | null }) => ({ driver, model, effort });

test("change agent: bad input and started work leave the task alone", () => {
  const { store, actions, taskId } = approved();
  const id = taskId("ui");
  const before = pick(store.getTask(id)!);
  assert.throws(() => actions.changeAgent(id, {}), /Give an agent/);
  assert.throws(() => actions.changeAgent(id, { driver: "nope" }), /Unknown agent/);
  assert.throws(() => actions.changeAgent(id, { driver: "codex", effort: "max" }), /takes effort/);
  assert.throws(() => actions.changeAgent(id, { model: "model; command" }), /doesn't look like a model/);
  assert.throws(() => actions.changeAgent(id, { driver: "simulated", model: "opus" }), /doesn't call a model/);
  assert.throws(() => actions.changeAgent(id, { driver: "default", model: "opus" }), /Choose an agent/);
  assert.deepEqual(pick(store.getTask(id)!), before);
  for (const status of ["running", "merging", "needs_review", "merged", "failed"] as TaskStatus[]) {
    store.updateTask(id, { status });
    assert.throws(() => actions.changeAgent(id, { driver: "codex" }), /isn't queued/, status);
  }
  assert.deepEqual(pick(store.getTask(id)!), before);
});

test("change agent: saving no change records nothing", () => {
  const { store, actions, taskId } = approved();
  const id = taskId("ui");
  actions.changeAgent(id, { driver: "claude-code", model: "sonnet", effort: "high" });
  assert.equal(hasEvent(store, id, /Changed agent/), false);
});

test("change agent: captured settings can't fill in for a model the operator cleared", () => {
  const { store, actions, taskId } = approved();
  const id = taskId("ui");
  captureSettings(store, id);
  actions.changeAgent(id, { model: null });
  assert.equal(store.getTask(id)!.driverSettings, null);
});

test("change agent: a draft plan changes through its revision, and approved work is the task's to change", () => {
  const { store, actions, goal } = setup();
  assert.throws(() => actions.changeGoalPlanAgent(goal.id, goal.revision - 1, "ui", { driver: "codex" }), /goal changed/);
  assert.throws(() => actions.changeGoalPlanAgent(goal.id, goal.revision, "nope", { driver: "codex" }), /no task nope/);
  assert.throws(() => actions.changeGoalPlanAgent(goal.id, goal.revision, "ui", { driver: "default" }), /Choose an agent/);
  assert.throws(() => actions.changeGoalPlanAgent(goal.id, goal.revision, "ui", { driver: "codex", effort: "max" }), /takes effort/);
  const edited = actions.changeGoalPlanAgent(goal.id, goal.revision, "ui", { driver: "codex" });
  assert.equal(edited.revision, goal.revision + 1);
  assert.deepEqual(pick(edited.plan!.tasks.find((t) => t.key === "ui")!), { driver: "codex", model: null, effort: null });
  assert.equal(edited.plan!.tasks.find((t) => t.key === "storage")!.driver, "codex", "other tasks stay");
  const live = actions.approveGoal(goal.id, edited.revision);
  assert.equal(store.getTask(live.tasks.find((t) => t.key === "ui")!.taskId)!.driver, "codex", "approval queues the changed agent");
  assert.throws(() => actions.changeGoalPlanAgent(goal.id, live.revision, "ui", { driver: "claude-code" }), /cannot be replanned/);
});

test("retry: a goal task can retry on a chosen model and effort, and reconnects its dependents", () => {
  const { store, actions, goal, taskId } = approved();
  const failed = taskId("storage");
  captureSettings(store, failed);
  store.setStatus(failed, "failed");
  store.syncGoals();
  const retried = actions.retryGoalTask(goal.id, store.getGoal(goal.id)!.revision, failed, { driver: "claude-code", model: "opus", effort: "high" });
  const next = store.getTask(retried.tasks.find((t) => t.key === "storage")!.taskId)!;
  assert.deepEqual(pick(next), { driver: "claude-code", model: "opus", effort: "high" });
  assert.equal(next.driverSettings, null);
  assert.deepEqual(store.getTask(taskId("ui"))!.prerequisites, [next.id]);
  assert.ok(hasEvent(store, failed, /on Claude Code \(opus · high effort\)/));

  store.setStatus(next.id, "failed");
  store.syncGoals();
  const same = actions.retryGoalTask(goal.id, store.getGoal(goal.id)!.revision, next.id);
  assert.deepEqual(pick(store.getTask(same.tasks.find((t) => t.key === "storage")!.taskId)!), { driver: "claude-code", model: "opus", effort: "high" }, "a plain retry keeps the choice");
});

test("goal progress: each status has one phase, and an approved branch still needs the operator", () => {
  const phase = (status: TaskStatus, branch: string | null = null) => goalTaskPhase({ status, branch });
  assert.equal(phase("running"), "working");
  assert.equal(phase("merging"), "working");
  assert.equal(phase("queued"), "waiting");
  assert.equal(phase("merged", "crane/x"), "done");
  assert.equal(phase("approved"), "done");
  assert.equal(phase("done"), "done");
  assert.equal(phase("approved", "crane/x"), "review");
  assert.equal(phase("done", "crane/x"), "review");
  assert.equal(phase("needs_review"), "review");
  for (const status of ["failed", "cancelled", "rejected"] as TaskStatus[]) assert.equal(phase(status), "stopped");
  const progress = goalProgress([{ status: "merged", branch: null }, { status: "running", branch: null }, { status: "queued", branch: null }]);
  assert.deepEqual(progress, { stopped: 0, review: 0, working: 1, waiting: 1, done: 1 });
  assert.deepEqual(Object.keys(progress).sort(), [...GOAL_TASK_PHASES].sort());
});

test("goal list: rows carry progress and planned tasks", () => {
  const { store, actions, repo, goal, taskId } = approved();
  const other = actions.createGoal({ repoId: repo.id, outcome: "Still researching" });
  store.updateTask(taskId("storage"), { status: "merged" });
  const rows = goalListItems(store);
  const row = rows.find((g) => g.id === goal.id)!;
  assert.equal(row.plannedTasks, 2);
  assert.deepEqual(row.progress, { stopped: 0, review: 0, working: 0, waiting: 1, done: 1 });
  const empty = rows.find((g) => g.id === other.id)!;
  assert.equal(empty.plannedTasks, 0);
  assert.deepEqual(empty.progress, { stopped: 0, review: 0, working: 0, waiting: 0, done: 0 });
});

test("api: change agent on a queued task or a draft plan, retry with settings, and list progress", async () => {
  const { store, actions, goal } = setup();
  const app = createApp(store);
  const post = (path: string, body: unknown) => app.request(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const planned = await post(`/goals/${goal.id}/plan/tasks/ui/agent`, { revision: goal.revision, driver: "codex", effort: "low" });
  assert.equal(planned.status, 200);
  const edited = await planned.json() as typeof goal;
  assert.equal(edited.plan!.tasks.find((t) => t.key === "ui")!.effort, "low");
  const live = actions.approveGoal(goal.id, edited.revision);
  const ui = live.tasks.find((t) => t.key === "ui")!.taskId;
  const changed = await post(`/tasks/${ui}/agent`, { driver: "claude-code", model: "opus" });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json() as { model: string }).model, "opus");
  assert.notEqual((await post(`/tasks/${ui}/agent`, { driver: "nope" })).status, 200);

  const storage = live.tasks.find((t) => t.key === "storage")!.taskId;
  store.setStatus(storage, "failed");
  store.syncGoals();
  const retried = await post(`/goals/${goal.id}/tasks/${storage}/retry`, { revision: store.getGoal(goal.id)!.revision, driver: "claude-code", model: "opus", effort: "high" });
  assert.equal(retried.status, 200);
  const next = (await retried.json() as typeof goal).tasks.find((t) => t.key === "storage")!.taskId;
  assert.equal(store.getTask(next)!.model, "opus");

  const list = await (await app.request("/api/goals")).json() as GoalListItem[];
  assert.deepEqual(list[0]!.progress, { stopped: 0, review: 0, working: 0, waiting: 2, done: 0 });
});
