import { validateGoalPlan, type DriverName, type Goal, type NewGoal, type TaskRunOptions } from "@crane/contracts";
import type { Store } from "@crane/storage";
import { checkTaskRunOptions, nextRun } from "../action-inputs.js";
import { goalResearchTask } from "../goals.js";
import { preApprove } from "./review.js";
import { retryTask } from "./tasks.js";

export function createGoal(store: Store, input: NewGoal): Goal {
  if (typeof input.outcome !== "string" || !input.outcome.trim() || input.outcome.trim().length > 20000) throw new Error("Describe the desired outcome in 1 to 20000 characters");
  const repo = typeof input.repoId === "string" ? store.getRepo(input.repoId) : null;
  if (!repo) throw new Error("Choose a connected repo for this goal");
  const outcome = input.outcome.trim();
  const research = checkTaskRunOptions(input);
  return store.createGoal({ outcome, title: outcome.split("\n")[0]!.slice(0, 120), repoId: repo.id, research },
    goalResearchTask(store, repo, { outcome, research }));
}

export function reviseGoal(store: Store, id: string, revision: unknown, feedback: unknown): Goal {
  const goal = store.getGoal(id);
  if (!goal) throw new Error(`No goal ${id}`);
  if (typeof feedback !== "string" || !feedback.trim() || feedback.trim().length > 20000) throw new Error("Give feedback in 1 to 20000 characters");
  const repo = store.getRepo(goal.repoId);
  if (!repo) throw new Error("The goal's repo is no longer connected");
  const text = feedback.trim();
  return store.reviseGoal(id, revision, text,
    goalResearchTask(store, repo, { outcome: goal.outcome, research: goal.research, previous: goal, feedback: text }));
}

export function editGoalPlan(store: Store, id: string, revision: unknown, input: unknown): Goal {
  return store.saveGoalPlan(id, revision, validateGoalPlan(input));
}

export function approveGoal(store: Store, id: string, revision: unknown, autoMerge: unknown = false): Goal {
  if (typeof autoMerge !== "boolean") throw new Error("Automatic merging must be a boolean");
  return store.approveGoal(id, revision, autoMerge);
}

export function retryGoalTask(store: Store, id: string, revision: unknown, taskId: string, opts: TaskRunOptions = {}): Goal {
  return store.retryGoalTask(id, revision, taskId, () => {
    const next = retryTask(store, taskId, opts);
    if (store.getGoal(id)!.autoMerge) preApprove(store, next.id, "Retry of an approved goal task");
    return store.getTask(next.id)!;
  });
}

/**
 * Change who runs one task in a draft plan. Saving goes through the same
 * revision check and plan validation as any other edit. Once the plan is
 * approved, change the queued task itself with `changeAgent`.
 */
export function changeGoalPlanAgent(store: Store, id: string, revision: unknown, key: string, input: TaskRunOptions): Goal {
  const goal = store.getGoal(id);
  if (!goal) throw new Error(`No goal ${id}`);
  const item = goal.plan?.tasks.find((t) => t.key === key);
  if (!item) throw new Error(`This goal's plan has no task ${key}`);
  const run = nextRun(item, input);
  if (!run.driver) throw new Error("Choose an agent for this plan task");
  const changed = { ...item, driver: run.driver as DriverName, model: run.model, effort: run.effort };
  return store.saveGoalPlan(id, revision, { ...goal.plan!, tasks: goal.plan!.tasks.map((t) => t.key === key ? changed : t) });
}
