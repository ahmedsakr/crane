import {
  errorMessage,
  goalWaves,
  validateGoalPlan,
  type Goal,
  type GoalDetail,
  type GoalPlan,
  type GoalSummary,
  type NewTask,
  type Repo,
  type Task,
  type TaskStatus,
} from "@crane/contracts";
import { shortId } from "../ids.js";
import type { Store } from "../store.js";
import { now } from "./shared.js";

export type NewGoal = Pick<Goal, "title" | "outcome" | "repoId" | "research">;

type PlanTask = GoalPlan["tasks"][number];

const SYNCED_STATUSES = ["researching", "active", "blocked"];
const RETRYABLE_TASK_STATUSES = ["failed", "cancelled", "rejected"];
const CANCELLABLE_TASK_STATUSES = ["queued", "running", "needs_review", "done", "approved"];

// Goals retain every research revision and its task links across restarts.
export function getGoal(store: Store, id: string): Goal | null {
  const row = store.db.prepare("SELECT data FROM goals WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) as Goal : null;
}

export function listGoals(store: Store): Goal[] {
  return (store.db.prepare("SELECT data FROM goals ORDER BY rowid DESC").all() as { data: string }[])
    .map((row) => JSON.parse(row.data) as Goal);
}

export function listGoalSummaries(store: Store, needsReview = false): GoalSummary[] {
  return store.db.prepare(`SELECT id, status,
    json_extract(data, '$.title') AS title, json_extract(data, '$.repoId') AS repoId,
    json_array_length(data, '$.tasks') AS taskCount FROM goals
    ${needsReview ? "WHERE status IN ('needs_review', 'blocked')" : ""} ORDER BY rowid DESC`)
    .all() as GoalSummary[];
}

export function goalDetail(store: Store, id: string): GoalDetail {
  const goal = getGoal(store, id);
  if (!goal) throw new Error(`No goal ${id}`);
  return { goal, research: store.getTask(goal.researchTaskId),
    tasks: goal.tasks.flatMap((t) => { const task = store.getTask(t.taskId); return task ? [task] : []; }) };
}

export function goalForTask(store: Store, taskId: string): string | null {
  const row = store.db.prepare("SELECT goal_id FROM goal_tasks WHERE task_id = ?").get(taskId) as { goal_id: string } | undefined;
  return row?.goal_id ?? null;
}

function writeGoal(store: Store, goal: Goal) {
  store.db.prepare("INSERT INTO goals(id, status, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
    .run(goal.id, goal.status, JSON.stringify(goal));
}

function linkGoalTask(store: Store, goalId: string, taskId: string) {
  store.db.prepare("INSERT INTO goal_tasks(task_id, goal_id) VALUES(?, ?)").run(taskId, goalId);
  store.addEvent(taskId, "note", `Part of goal ${goalId}`, { goalId });
}

/** Version checks prevent stale tabs and duplicate decisions from starting extra work. */
function goalAtRevision(store: Store, id: string, revision: unknown): Goal {
  const goal = getGoal(store, id);
  if (!goal) throw new Error(`No goal ${id}`);
  if (!Number.isSafeInteger(revision) || goal.revision !== revision) throw new Error("The goal changed. Reload it before deciding");
  return goal;
}

function editableGoal(store: Store, id: string, revision: unknown): Goal {
  const goal = goalAtRevision(store, id, revision);
  if (goal.approvedAt || !["needs_review", "blocked"].includes(goal.status)) throw new Error("Wait for research to finish; approved goals cannot be replanned");
  return goal;
}

export function createGoal(store: Store, input: NewGoal, researchTask: NewTask): Goal {
  return store.db.transaction(() => {
    const ts = now();
    const task = store.createTask(researchTask);
    const goal: Goal = { ...input, id: shortId("g"), status: "researching", revision: 1, plan: null,
      researchTaskId: task.id, feedback: [], tasks: [], autoMerge: false, approvedAt: null,
      createdAt: ts, updatedAt: ts, error: null };
    writeGoal(store, goal);
    linkGoalTask(store, goal.id, task.id);
    return goal;
  }).immediate();
}

export function reviseGoal(store: Store, id: string, revision: unknown, feedback: string, researchTask: NewTask): Goal {
  return store.db.transaction(() => {
    const goal = editableGoal(store, id, revision);
    const task = store.createTask(researchTask);
    goal.revision++;
    goal.feedback.push({ revision: goal.revision, text: feedback, taskId: task.id });
    goal.researchTaskId = task.id;
    goal.status = "researching";
    goal.error = null;
    goal.updatedAt = now();
    writeGoal(store, goal);
    linkGoalTask(store, id, task.id);
    return goal;
  }).immediate();
}

export function saveGoalPlan(store: Store, id: string, revision: unknown, plan: GoalPlan): Goal {
  return store.db.transaction(() => {
    const goal = editableGoal(store, id, revision);
    goal.plan = validateGoalPlan(plan);
    goal.revision++;
    goal.status = "needs_review";
    goal.error = null;
    goal.updatedAt = now();
    writeGoal(store, goal);
    store.addEvent(goal.researchTaskId, "operator", "Edited goal plan", { goalId: id, revision: goal.revision });
    return goal;
  }).immediate();
}

function goalTaskBrief(outcome: string, plan: GoalPlan, item: PlanTask): string {
  return `Goal: ${outcome}\n\nPlan: ${plan.summary}\n\nApproach: ${plan.approach}\n\nYour task (${item.key}):\n${item.brief}\n\nAssignment rationale: ${item.rationale}`;
}

function assertAcceptanceChecksConfigured(plan: GoalPlan, checks: string[]) {
  for (const item of plan.tasks) {
    const missing = item.acceptanceChecks?.find((command) => !checks.includes(command));
    if (missing) throw new Error(`${item.key} requires “${missing}”, which isn't one of this repo's checks, so Crane would never run it`);
  }
}

/** Creates tasks in wave order, so each task's prerequisites already have ids. */
function createPlanTasks(store: Store, goal: Goal, plan: GoalPlan, repo: Repo, autoMerge: boolean): Map<string, string> {
  const ids = new Map<string, string>();
  for (const wave of goalWaves(plan)) {
    for (const item of wave) {
      const task = store.createTask({ title: item.title,
        brief: goalTaskBrief(goal.outcome, plan, item),
        kind: repo.isFactory ? "factory_feature" : "repo_feature", repoId: repo.id, autonomy: "propose",
        driver: item.driver, model: item.model, effort: item.effort,
        prerequisites: item.dependsOn.map((key) => ids.get(key)!), acceptance: item.acceptance, acceptanceChecks: item.acceptanceChecks,
        lookouts: ["improvements", "refactoring"], preApprove: autoMerge });
      ids.set(item.key, task.id);
      linkGoalTask(store, goal.id, task.id);
    }
  }
  return ids;
}

/** Queue the entire approved DAG in one write transaction; claims cannot see a partial graph. */
export function approveGoal(store: Store, id: string, revision: unknown, autoMerge: boolean): Goal {
  return store.db.transaction(() => {
    const goal = editableGoal(store, id, revision);
    if (goal.status !== "needs_review" || !goal.plan) throw new Error("A valid researched plan is required before approval");
    const plan = validateGoalPlan(goal.plan);
    const repo = store.getRepo(goal.repoId);
    if (!repo) throw new Error("The goal's repo is no longer connected");
    assertAcceptanceChecksConfigured(plan, store.repoChecks(repo.id));
    const ids = createPlanTasks(store, goal, plan, repo, autoMerge);
    goal.tasks = plan.tasks.map((t) => ({ key: t.key, taskId: ids.get(t.key)! }));
    goal.revision++;
    goal.status = "active";
    goal.autoMerge = autoMerge;
    goal.approvedAt = goal.updatedAt = now();
    writeGoal(store, goal);
    store.addEvent(goal.researchTaskId, "operator", "Approved goal plan", { goalId: id, revision, autoMerge });
    return goal;
  }).immediate();
}

export function cancelGoal(store: Store, id: string, revision: unknown): Goal {
  return store.db.transaction(() => {
    const goal = goalAtRevision(store, id, revision);
    if (["completed", "cancelled"].includes(goal.status)) throw new Error("This goal has already ended");
    // Running work and merges use the usual task cancellation path/worker guard.
    const ids = [goal.researchTaskId, ...goal.tasks.map((t) => t.taskId)];
    if (ids.some((taskId) => store.getTask(taskId)?.status === "merging")) throw new Error("Wait for the current merge to finish before cancelling the goal");
    for (const taskId of ids) {
      const task = store.getTask(taskId);
      if (task && CANCELLABLE_TASK_STATUSES.includes(task.status)) {
        store.setStatus(taskId, "cancelled", "Goal cancelled by the operator");
      }
    }
    goal.status = "cancelled";
    goal.revision++;
    goal.updatedAt = now();
    writeGoal(store, goal);
    return goal;
  }).immediate();
}

/** The research task's validated plan; throws the text the goal shows when research can't proceed. */
function researchedPlan(task: Task | null): GoalPlan {
  if (!task || !["done", "needs_review", "approved"].includes(task.status)) throw new Error("Research failed or was cancelled. Send feedback to research again");
  if (task.report?.completion?.status !== "completed") throw new Error("Research did not report completed planning. Review the research report and send feedback");
  return validateGoalPlan(task.report.goalPlan);
}

function applyResearchResult(goal: Goal, task: Task | null) {
  try {
    goal.plan = researchedPlan(task);
    goal.status = "needs_review";
    goal.error = null;
  } catch (err) {
    goal.status = "blocked";
    goal.error = errorMessage(err);
  }
}

/** Returns whether the goal changed and needs writing. */
function reconcileResearch(store: Store, goal: Goal): boolean {
  const task = store.getTask(goal.researchTaskId);
  if (task && ["queued", "running"].includes(task.status)) return false;
  applyResearchResult(goal, task);
  if (goal.status === "needs_review" && task?.status === "needs_review") {
    store.setStatus(task.id, "done", "Research complete; review the plan on its goal", { goalId: goal.id });
  }
  return true;
}

function executionStatus(complete: boolean, failed: boolean): Goal["status"] {
  if (complete) return "completed";
  return failed ? "blocked" : "active";
}

/** Returns whether the goal changed and needs writing. */
function reconcileExecution(store: Store, goal: Goal): boolean {
  // Poll statuses alone: agent reports and briefs can be large while work is in flight.
  const tasks = store.db.prepare(`SELECT status FROM tasks WHERE id IN (${goal.tasks.map(() => "?").join(",")})`)
    .all(...goal.tasks.map((t) => t.taskId)) as { status: TaskStatus }[];
  const failed = tasks.length !== goal.tasks.length || tasks.some((t) => RETRYABLE_TASK_STATUSES.includes(t.status));
  const complete = tasks.length > 0 && tasks.every((t) => t.status === "merged");
  const status = executionStatus(complete, failed);
  if (status === goal.status) return false;
  goal.status = status;
  goal.error = failed ? "A goal task failed, was declined, or was cancelled. Retry it from this goal to reconnect its dependents" : null;
  return true;
}

function reconcileGoal(store: Store, goal: Goal): boolean {
  if (goal.status === "researching") return reconcileResearch(store, goal);
  if (goal.approvedAt) return reconcileExecution(store, goal);
  return false;
}

/** Reconcile persisted task results, including after a crash between task completion and the next tick. */
export function syncGoals(store: Store): void {
  const pending = store.db.prepare("SELECT id FROM goals WHERE status IN ('researching', 'active', 'blocked')").all() as { id: string }[];
  for (const snapshot of pending) {
    store.db.transaction(() => {
      const goal = getGoal(store, snapshot.id)!;
      if (!SYNCED_STATUSES.includes(goal.status)) return;
      if (!reconcileGoal(store, goal)) return;
      goal.revision++;
      goal.updatedAt = now();
      writeGoal(store, goal);
    }).immediate();
  }
}

/** Retry copies the approved task, including gates. Rewire waiting children, including a retry's own gates. */
function rewireWaitingTasks(store: Store, goal: Goal, oldTaskId: string, nextTaskId: string) {
  for (const item of goal.tasks) {
    const task = store.getTask(item.taskId);
    if (task?.status === "queued" && task.prerequisites.includes(oldTaskId)) {
      store.db.prepare("UPDATE tasks SET prerequisites = ? WHERE id = ?")
        .run(JSON.stringify(task.prerequisites.map((p) => p === oldTaskId ? nextTaskId : p)), task.id);
      store.addEvent(task.id, "operator", `Goal prerequisite ${oldTaskId} replaced by retry ${nextTaskId}`, { goalId: goal.id });
    }
  }
}

export function retryGoalTask(store: Store, id: string, revision: unknown, taskId: string, retry: () => Task): Goal {
  return store.db.transaction(() => {
    const goal = goalAtRevision(store, id, revision);
    if (!goal.approvedAt || !["active", "blocked"].includes(goal.status)) throw new Error("Only executing goals can retry a task");
    const link = goal.tasks.find((t) => t.taskId === taskId);
    if (!link) throw new Error("This task does not belong to the goal");
    const old = store.getTask(taskId);
    if (!old || !RETRYABLE_TASK_STATUSES.includes(old.status)) throw new Error("Only failed, cancelled or declined goal tasks can be retried");
    const next = retry();
    link.taskId = next.id;
    linkGoalTask(store, id, next.id);
    rewireWaitingTasks(store, goal, taskId, next.id);
    goal.revision++;
    goal.updatedAt = now();
    writeGoal(store, goal);
    return goal;
  }).immediate();
}
