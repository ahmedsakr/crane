import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalWaves, validateGoalPlan, type Goal, type GoalPlan, type Report } from "@crane/contracts";
import { parseReport, type AgentDriver } from "@crane/agent-protocol";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { Factory } from "@crane/factory/runtime";
import { createApp } from "../src/server/app.js";
import { SimulatedDriver } from "@crane/agent-drivers";

const plan = (): GoalPlan => ({ summary: "Deliver reliable saved carts", approach: "Extract cart storage first; then UI and API can run together. Integrate after both land.",
  improvements: ["Later, unify the cart and checkout telemetry"], tasks: [
    { key: "storage", title: "Extract cart storage", brief: "Extract storage and retain existing behavior", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "Careful contract refactoring before callers change", acceptance: ["Existing storage callers keep working"] },
    { key: "ui", title: "Build saved cart UI", brief: "Use the storage contract for saved carts", dependsOn: ["storage"], driver: "claude-code", model: "sonnet", effort: "high", rationale: "UI work after the shared contract lands", acceptance: ["Saved carts can be reopened"] },
    { key: "api", title: "Add saved cart API", brief: "Use the storage contract in the API", dependsOn: ["storage"], driver: "codex", model: null, effort: "medium", rationale: "Independent API work after the contract", acceptance: ["API can save and restore a cart"] },
    { key: "integration", title: "Verify saved carts", brief: "Exercise both paths and fix integration gaps", dependsOn: ["ui", "api"], driver: "claude-code", model: "opus", effort: "high", rationale: "Cross-cutting verification after both branches merge", acceptance: ["A cart saved through the UI survives reload"] },
  ] });

function setup(file = ":memory:") {
  const store = new Store(file);
  const repo = store.addRepo({ path: "/goals-repo", name: "storefront" });
  const actions = new OperatorActions(store);
  const goal = actions.createGoal({ repoId: repo.id, outcome: "Customers can save and reopen carts", driver: "codex", effort: "high" });
  return { store, repo, actions, goal };
}

function researchResult(store: Store, goal: Goal, change: Partial<Report> = {}) {
  store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Planning complete", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Research complete", evidence: "Read storage, API and UI" }, goalPlan: plan(), ...change } });
  store.syncGoals();
  return store.getGoal(goal.id)!;
}

test("goals: validate DAGs, provider settings, complete briefs and stable waves", () => {
  assert.deepEqual(goalWaves(validateGoalPlan(plan())).map((w) => w.map((t) => t.key)), [["storage"], ["ui", "api"], ["integration"]]);
  const mutations: ((p: GoalPlan) => void)[] = [
    (p) => { p.tasks[0]!.dependsOn = ["integration"]; },
    (p) => { p.tasks[0]!.dependsOn = ["missing"]; },
    (p) => { p.tasks[0]!.dependsOn = ["storage"]; },
    (p) => { p.tasks[0]!.key = "ui"; },
    (p) => { p.tasks[0]!.effort = "max"; }, // Claude effort cannot be given to Codex
    (p) => { p.tasks[0]!.model = "model; command"; },
    (p) => { p.tasks[0]!.acceptance = []; },
    (p) => { p.tasks[0]!.brief = ""; },
    (p) => { p.tasks = []; },
  ];
  for (const mutate of mutations) { const p = plan(); mutate(p); assert.throws(() => validateGoalPlan(p)); }
  for (const invalid of [null, [], {}, { ...plan(), tasks: [null] }]) assert.throws(() => validateGoalPlan(invalid));
  const report = parseReport('```crane-report\n' + JSON.stringify({ summary: "Ready", findings: [], changedFiles: [], goalPlan: plan(), validation: [{ status: "passed" }] }) + '\n```');
  assert.deepEqual(report.goalPlan, plan());
  assert.equal(report.validation, undefined);
});

test("goals: research is read-only, feedback preserves context and approval targets an exact revision", () => {
  const { store, actions, goal } = setup();
  try {
    const research = store.getTask(goal.researchTaskId)!;
    assert.equal(research.autonomy, "observe");
    assert.equal(research.driver, "codex");
    assert.equal(research.effort, "high");
    assert.match(research.brief, /refactoring/);
    assert.match(research.brief, /goalPlan/);
    assert.throws(() => actions.approveGoal(goal.id, goal.revision), /research/);
    const ready = researchResult(store, goal);
    assert.equal(ready.status, "needs_review");
    assert.equal(store.getTask(goal.researchTaskId)!.status, "done", "the goal owns plan review, avoiding a second task decision");
    assert.equal(store.listTasks().length, 1);
    assert.throws(() => actions.approveGoal(goal.id, goal.revision), /changed/);
    const revised = actions.reviseGoal(ready.id, ready.revision, "Keep checkout unchanged and add accessibility acceptance");
    const newResearch = store.getTask(revised.researchTaskId)!;
    assert.notEqual(newResearch.id, research.id);
    assert.equal(newResearch.sessionId, null);
    assert.match(newResearch.brief, /Keep checkout unchanged/);
    assert.match(newResearch.brief, /Extract cart storage/);
    assert.equal(store.goalForTask(research.id), goal.id);
    assert.throws(() => actions.approveGoal(revised.id, revised.revision), /research/);
    const readyAgain = researchResult(store, revised);
    const edited = actions.editGoalPlan(readyAgain.id, readyAgain.revision, { ...plan(), summary: "Revised scope" });
    assert.throws(() => actions.approveGoal(edited.id, readyAgain.revision), /changed/);
    const approved = actions.approveGoal(edited.id, edited.revision, false);
    assert.equal(approved.tasks.length, 4);
    assert.equal(approved.autoMerge, false);
    assert.equal(store.listTasks().length, 6);
    assert.throws(() => actions.approveGoal(edited.id, edited.revision, true), /changed/);
    assert.throws(() => actions.reviseGoal(approved.id, approved.revision, "Change scope"), /approved/);
    assert.equal(store.listTasks().length, 6, "duplicate approval created no tasks");
    assert.ok(store.goalDetail(goal.id).tasks.every((t) => t.preApprovedAt === null));
  } finally { store.close(); }
});

test("goals: invalid and incomplete research block execution and can be researched again", () => {
  for (const change of [{ goalPlan: { tasks: [] } }, { completion: undefined },
    { completion: { status: "blocked", reason: "Missing prerequisite", evidence: "No shared contract" } } satisfies Partial<Report>]) {
    const { store, actions, goal } = setup();
    try {
      const blocked = researchResult(store, goal, change);
      assert.equal(blocked.status, "blocked");
      assert.ok(blocked.error);
      assert.equal(blocked.plan, null);
      assert.throws(() => actions.approveGoal(blocked.id, blocked.revision), /valid researched plan/);
      assert.equal(store.listTasks().length, 1);
      const next = actions.reviseGoal(blocked.id, blocked.revision, "Resolve the research blocker");
      assert.equal(next.status, "researching");
    } finally { store.close(); }
  }
});

test("goals: approval composes exact briefs and creates tasks in wave order", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    const approved = actions.approveGoal(ready.id, ready.revision);
    const titles = store.db.prepare("SELECT title FROM tasks WHERE id != ? ORDER BY rowid").all(goal.researchTaskId) as { title: string }[];
    assert.deepEqual(titles.map((t) => t.title), ["Extract cart storage", "Build saved cart UI", "Add saved cart API", "Verify saved carts"]);
    const taskId = (key: string) => approved.tasks.find((t) => t.key === key)!.taskId;
    assert.deepEqual(store.getTask(taskId("integration"))!.prerequisites, [taskId("ui"), taskId("api")]);
    assert.equal(store.getTask(taskId("storage"))!.brief, "Goal: Customers can save and reopen carts\n\n"
      + `Plan: ${plan().summary}\n\nApproach: ${plan().approach}\n\n`
      + "Your task (storage):\nExtract storage and retain existing behavior\n\n"
      + "Assignment rationale: Careful contract refactoring before callers change");
  } finally { store.close(); }
});

test("goals: reconciliation keeps its statuses and error text, and an unchanged tick writes nothing", () => {
  const { store, actions, goal } = setup();
  try {
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.revision, goal.revision, "research still in flight leaves the goal alone");
    store.updateTask(goal.researchTaskId, { status: "failed" });
    store.syncGoals();
    const failed = store.getGoal(goal.id)!;
    assert.equal(failed.status, "blocked");
    assert.equal(failed.error, "Research failed or was cancelled. Send feedback to research again");
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.revision, failed.revision, "an unapproved blocked goal is stable across ticks");
    const revised = actions.reviseGoal(failed.id, failed.revision, "Try again");
    const incomplete = researchResult(store, revised, { completion: undefined });
    assert.equal(incomplete.error, "Research did not report completed planning. Review the research report and send feedback");
    const again = actions.reviseGoal(incomplete.id, incomplete.revision, "Finish planning");
    const ready = researchResult(store, again);
    const active = actions.approveGoal(ready.id, ready.revision);
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.revision, active.revision, "an active goal with work pending is stable across ticks");
    store.updateTask(active.tasks[0]!.taskId, { status: "rejected" });
    store.syncGoals();
    const blocked = store.getGoal(goal.id)!;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error, "A goal task failed, was declined, or was cancelled. Retry it from this goal to reconnect its dependents");
    for (const link of active.tasks) store.updateTask(link.taskId, { status: "merged" });
    store.syncGoals();
    const completed = store.getGoal(goal.id)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.error, null);
    assert.equal(completed.revision, blocked.revision + 1);
  } finally { store.close(); }
});

test("goals: a missing task row blocks the goal even when every remaining task merged", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    const active = actions.approveGoal(ready.id, ready.revision);
    for (const link of active.tasks) store.updateTask(link.taskId, { status: "merged" });
    // Nothing deletes task rows today, so the fixture has to step around the foreign keys.
    store.db.pragma("foreign_keys = OFF");
    store.db.prepare("DELETE FROM tasks WHERE id = ?").run(active.tasks[0]!.taskId);
    store.db.pragma("foreign_keys = ON");
    store.syncGoals();
    const blocked = store.getGoal(goal.id)!;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.error, "A goal task failed, was declined, or was cancelled. Retry it from this goal to reconnect its dependents");
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.revision, blocked.revision, "a blocked goal with a missing row is stable across ticks");
  } finally { store.close(); }
});

test("goals: a recording failure rolls research reconciliation back for a later retry", () => {
  const { store, goal } = setup();
  try {
    store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Ready", findings: [], changedFiles: [],
      goalPlan: plan(), completion: { status: "completed", reason: "Planning complete", evidence: "Read repo" } } });
    store.db.exec("CREATE TRIGGER reject_goal_recording BEFORE INSERT ON events WHEN NEW.message = 'Research complete; review the plan on its goal' BEGIN SELECT RAISE(ABORT, 'fixture recording failure'); END");
    assert.throws(() => store.syncGoals(), /fixture recording failure/);
    assert.equal(store.getGoal(goal.id)!.status, "researching");
    assert.equal(store.getTask(goal.researchTaskId)!.status, "needs_review");
    store.db.exec("DROP TRIGGER reject_goal_recording");
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.status, "needs_review");
    assert.equal(store.getTask(goal.researchTaskId)!.status, "done");
  } finally { store.close(); }
});

test("goals: approval rollback leaves no partial tasks and default approval never pre-approves merges", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    store.db.exec("CREATE TRIGGER reject_api BEFORE INSERT ON tasks WHEN NEW.title = 'Add saved cart API' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => actions.approveGoal(ready.id, ready.revision, true), /fixture failure/);
    assert.equal(store.listTasks().length, 1);
    assert.deepEqual(store.getGoal(goal.id), ready);
    assert.deepEqual(store.db.prepare("SELECT COUNT(*) AS n FROM goal_tasks").get(), { n: 1 });
    store.db.exec("DROP TRIGGER reject_api");
    actions.approveGoal(ready.id, ready.revision);
    assert.ok(store.goalDetail(goal.id).tasks.every((t) => !t.preApprovedAt));
  } finally { store.close(); }
});

test("goals: automatic merging retains completion and acceptance holds", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    const active = actions.approveGoal(goal.id, ready.revision, true);
    const task = store.claimNextTask("a-one")!;
    assert.equal(task.id, active.tasks[0]!.taskId);
    const report: Report = { summary: "Unfinished", findings: [], changedFiles: ["src/cart.ts"], hasContribution: true,
      completion: { status: "blocked", reason: "Missing required behavior", evidence: "No restore path" },
      acceptance: task.acceptance.map((criterion) => ({ criterion, met: false, evidence: "Not implemented" })) };
    store.updateTask(task.id, { branch: "crane/cart", report });
    assert.equal(store.finishWork(task.id, "done"), "needs_review");
    store.updateTask(task.id, { status: "running", report: { ...report, completion: { status: "completed", reason: "Implemented", evidence: "Changed cart" } } });
    assert.equal(store.finishWork(task.id, "done"), "needs_review", "completion does not satisfy unmet acceptance");
    assert.equal(store.claimNextTask("a-two"), null);
  } finally { store.close(); }
});

test("goals: simulated research returns an explicitly labelled, valid demo plan", async () => {
  const { store, goal, repo } = setup();
  try {
    const result = await new SimulatedDriver(0).run({ task: store.getTask(goal.researchTaskId)!, repo, cwd: repo.path,
      signal: new AbortController().signal, emit: () => {} });
    assert.match(result.report.summary, /Simulated/);
    const simulated = validateGoalPlan(result.report.goalPlan);
    assert.equal(simulated.tasks.length, 4);
    assert.ok(simulated.tasks.every((t) => t.driver === "simulated" && t.model === null && t.effort === null));
  } finally { store.close(); }
});

test("goals: prerequisites unlock parallel crew claims only after merge and retries reconnect the graph", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    const active = actions.approveGoal(ready.id, ready.revision, true);
    const detail = store.goalDetail(goal.id);
    const byKey = (key: string) => detail.tasks.find((t) => t.id === active.tasks.find((l) => l.key === key)!.taskId)!;
    const storage = byKey("storage");
    assert.equal(store.claimNextTask("a-one")!.id, storage.id);
    assert.equal(store.claimNextTask("a-two"), null);
    store.updateTask(storage.id, { status: "needs_review", branch: "crane/storage" });
    assert.equal(store.claimNextTask("a-two"), null, "report completion is not a merge");
    store.setStatus(storage.id, "merged");
    const first = store.claimNextTask("a-one")!;
    const second = store.claimNextTask("a-two")!;
    assert.deepEqual(new Set([first.id, second.id]), new Set([byKey("ui").id, byKey("api").id]));
    assert.equal(first.driver, "claude-code");
    assert.equal(first.model, "sonnet");
    assert.equal(second.driver, "codex");
    assert.ok(first.preApprovedAt && second.preApprovedAt);
    assert.equal(store.claimNextTask("a-three"), null);
    store.setStatus(first.id, "failed");
    store.setStatus(second.id, "merged");
    store.syncGoals();
    const blocked = store.getGoal(goal.id)!;
    assert.equal(blocked.status, "blocked");
    assert.throws(() => actions.retry(first.id), /belongs to goal/);
    const retried = actions.retryGoalTask(goal.id, blocked.revision, first.id, { driver: "codex" });
    const replacementId = retried.tasks.find((t) => t.key === "ui")!.taskId;
    const replacement = store.getTask(replacementId)!;
    assert.equal(replacement.driver, "codex");
    assert.equal(replacement.model, null);
    assert.ok(replacement.preApprovedAt);
    assert.deepEqual(store.getTask(byKey("integration").id)!.prerequisites, [replacementId, second.id]);
    assert.throws(() => actions.retryGoalTask(goal.id, blocked.revision, first.id), /changed/);
    assert.equal(store.claimNextTask("a-three")!.id, replacementId);
    store.setStatus(replacementId, "merged");
    assert.equal(store.claimNextTask("a-three")!.id, byKey("integration").id);
    store.setStatus(byKey("integration").id, "merged");
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.status, "completed");
    const unchanged = store.db.prepare("SELECT total_changes() AS n").get();
    store.syncGoals();
    assert.deepEqual(store.db.prepare("SELECT total_changes() AS n").get(), unchanged, "idle reconciliation makes no writes");
  } finally { store.close(); }
});

test("goals: cancellation prevents further work and does not race a merge", () => {
  const { store, actions, goal } = setup();
  try {
    const ready = researchResult(store, goal);
    const active = actions.approveGoal(goal.id, ready.revision, true);
    const taskId = active.tasks[0]!.taskId;
    store.updateTask(taskId, { status: "merging" });
    assert.throws(() => actions.cancelGoal(goal.id, active.revision), /merge/);
    assert.equal(store.getGoal(goal.id)!.status, "active");
    store.updateTask(taskId, { status: "running" });
    const cancelled = actions.cancelGoal(goal.id, active.revision);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(store.finishWork(taskId, "done"), null);
    assert.equal(store.claimNextTask("a-one"), null);
    store.syncGoals();
    assert.equal(store.getGoal(goal.id)!.status, "cancelled");
    assert.throws(() => actions.retryGoalTask(goal.id, cancelled.revision, taskId), /executing/);
  } finally { store.close(); }
});

test("goals: research results and decisions survive store reopen without duplicate fan-out", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-goals-"));
  const file = join(dir, "crane.db");
  const initial = setup(file);
  const id = initial.goal.id;
  initial.store.updateTask(initial.goal.researchTaskId, { status: "done", report: { summary: "Ready", findings: [], changedFiles: [], goalPlan: plan(), completion: { status: "completed", reason: "Done", evidence: "Sources read" } } });
  initial.store.close();
  const store = new Store(file);
  try {
    store.syncGoals();
    const ready = store.getGoal(id)!;
    new OperatorActions(store).approveGoal(id, ready.revision, true);
  } finally { store.close(); }
  const reopened = new Store(file);
  try {
    reopened.syncGoals();
    assert.equal(reopened.getGoal(id)!.status, "active");
    assert.equal(reopened.goalDetail(id).tasks.length, 4);
    assert.equal(reopened.listTasks().length, 5);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("goals: two operator connections cannot approve the same graph twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-goal-race-"));
  const file = join(dir, "crane.db");
  const { store, actions, goal } = setup(file);
  const other = new Store(file);
  try {
    const ready = researchResult(store, goal);
    const revisionSeenByOther = other.getGoal(goal.id)!.revision;
    actions.approveGoal(goal.id, ready.revision, false);
    assert.throws(() => new OperatorActions(other).approveGoal(goal.id, revisionSeenByOther, true), /changed/);
    assert.equal(other.goalDetail(goal.id).tasks.length, 4);
    assert.equal(other.listTasks().length, 5);
  } finally { other.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("goals: actual factory research run feeds the goal review without starting implementation", async () => {
  const { store, goal } = setup();
  const driver: AgentDriver = { name: "codex", label: "fixture", available: async () => true, run: async (ctx) => {
    assert.equal(ctx.task.autonomy, "observe");
    assert.equal(ctx.effort, "high");
    return { report: { summary: "Plan ready", findings: [], changedFiles: [], goalPlan: plan(), completion: { status: "completed", reason: "Planning complete", evidence: "Read repo" } } };
  } };
  const factory = new Factory(store, driver, { tickMs: 5, buildDashboard: false });
  try {
    factory.start();
    const deadline = Date.now() + 2000;
    while (store.getGoal(goal.id)!.status === "researching" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.getGoal(goal.id)!.status, "needs_review");
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.listRuns(goal.researchTaskId)[0]!.outcome, "succeeded");
  } finally { await factory.stop(); store.close(); }
});

test("goals API: malformed decisions, stale versions and invalid graphs do not start work", async () => {
  const { store, goal } = setup();
  try {
    const app = createApp(store);
    const ready = researchResult(store, goal);
    const send = (path: string, body: unknown, method = "POST") => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [null, [], true, {}, { revision: ready.revision, autoMerge: "yes" }, { revision: goal.revision }]) {
      assert.equal((await send(`/api/goals/${goal.id}/approve`, body)).status, 400);
      assert.equal(store.listTasks().length, 1);
    }
    assert.equal((await send(`/api/goals/${goal.id}/plan`, { revision: ready.revision, plan: {} }, "PUT")).status, 400);
    assert.equal((await app.request("/api/goals/missing")).status, 404);
    const response = await send(`/api/goals/${goal.id}/approve`, { revision: ready.revision, autoMerge: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks.length, 4);
    const detail = await (await app.request(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.tasks.length, 4);
    const taskDetail = await (await app.request(`/api/tasks/${detail.tasks[0].id}`)).json();
    assert.equal(taskDetail.goalId, goal.id);
  } finally { store.close(); }
});
