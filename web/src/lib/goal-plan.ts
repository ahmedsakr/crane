/** Goal lists, decisions and plan edits, derived without React so each can be tested alone. */
import { goalProgress, type Goal, type GoalListItem, type GoalPlan, type GoalProgress, type GoalTask, type Task } from "@crane/contracts";
import { plural } from "./format.js";

const MAX_PLAN_TASKS = 40;

export type GoalDecisionMode = "feedback" | "approve" | "cancel";

export const DECISION_LABEL: Record<GoalDecisionMode, string> = {
  feedback: "Review feedback",
  approve: "Approve plan",
  cancel: "Cancel goal",
};

const LIST_GROUPS: { title: string; statuses: Goal["status"][]; fold?: boolean }[] = [
  { title: "Needs you", statuses: ["needs_review", "blocked"] },
  { title: "In progress", statuses: ["researching", "active"] },
  { title: "Finished", statuses: ["completed", "cancelled"], fold: true },
];

/** The list's non-empty groups, most urgent first. */
export function goalListGroups<G extends Pick<Goal, "status">>(goals: G[]) {
  return LIST_GROUPS
    .map((group) => ({ ...group, goals: goals.filter((goal) => group.statuses.includes(goal.status)) }))
    .filter((group) => group.goals.length > 0);
}

/** A backend older than this page sends no progress; read it as empty until it restarts. */
export function listProgress(goal: Pick<GoalListItem, "progress">): GoalProgress {
  return goal.progress ?? goalProgress([]);
}

export function plannedText(goal: Pick<GoalListItem, "plannedTasks">): string {
  return goal.plannedTasks ? `${plural(goal.plannedTasks, "task")} planned` : "Planning";
}

/** A plan can be approved, edited or sent back only before approval, and only once research has stopped. */
export function isPlanEditable(goal: Pick<Goal, "approvedAt" | "status">): boolean {
  return !goal.approvedAt && ["needs_review", "blocked"].includes(goal.status);
}

export function isCancellable(goal: Pick<Goal, "status">): boolean {
  return !["completed", "cancelled"].includes(goal.status);
}

export function taskForKey(goal: Pick<Goal, "tasks">, tasks: Task[], key: string): Task | undefined {
  const link = goal.tasks.find((t) => t.key === key);
  return tasks.find((t) => t.id === link?.taskId);
}

export const splitLines = (text: string): string[] => text.split("\n");

const filled = (lines: string[]) => lines.filter((line) => line.trim());

/** Blank lines are only a side effect of editing one per line, so they never reach the plan. */
export function withoutBlankLines(plan: GoalPlan): GoalPlan {
  return {
    ...plan,
    improvements: filled(plan.improvements),
    tasks: plan.tasks.map((t) => ({
      ...t,
      acceptance: filled(t.acceptance),
      acceptanceChecks: t.acceptanceChecks && filled(t.acceptanceChecks),
    })),
  };
}

export function patchTask(plan: GoalPlan, key: string, change: Partial<GoalTask>): GoalPlan {
  return { ...plan, tasks: plan.tasks.map((t) => (t.key === key ? { ...t, ...change } : t)) };
}

export function canAddTask(plan: GoalPlan): boolean {
  return plan.tasks.length < MAX_PLAN_TASKS;
}

export function addTask(plan: GoalPlan): GoalPlan {
  let n = plan.tasks.length + 1;
  while (plan.tasks.some((t) => t.key === `task-${n}`)) n++;
  const task: GoalTask = { key: `task-${n}`, title: "New task", brief: "", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "", acceptance: [] };
  return { ...plan, tasks: [...plan.tasks, task] };
}

/** Removes a task and every other task's dependency on it. */
export function removeTask(plan: GoalPlan, key: string): GoalPlan {
  const tasks = plan.tasks
    .filter((t) => t.key !== key)
    .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((dep) => dep !== key) }));
  return { ...plan, tasks };
}

export function withDependency(task: GoalTask, key: string, depends: boolean): string[] {
  return depends ? [...task.dependsOn, key] : task.dependsOn.filter((dep) => dep !== key);
}
