import { EFFORT_LEVELS, isDriverName } from "./drivers.js";
import type { DriverName } from "./drivers.js";
import { prerequisiteMet, type Task, type TaskRunOptions } from "./task.js";

export interface GoalTask {
  key: string;
  title: string;
  brief: string;
  dependsOn: string[];
  driver: DriverName;
  model: string | null;
  effort: string | null;
  rationale: string;
  acceptance: string[];
  /** Configured repo checks that must pass, by exact command. Plans saved before this field have none. */
  acceptanceChecks?: string[];
}

export interface GoalPlan {
  summary: string;
  /** Repo evidence, ordering, parallelism, risks and integration strategy. */
  approach: string;
  improvements: string[];
  tasks: GoalTask[];
}

export interface Goal {
  id: string;
  title: string;
  outcome: string;
  repoId: string;
  status: "researching" | "needs_review" | "active" | "completed" | "blocked" | "cancelled";
  /** Every plan edit, research request and decision advances this version. */
  revision: number;
  plan: GoalPlan | null;
  researchTaskId: string;
  research: TaskRunOptions;
  feedback: { revision: number; text: string; taskId: string }[];
  tasks: { key: string; taskId: string }[];
  autoMerge: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface NewGoal extends TaskRunOptions {
  outcome: string;
  repoId: string;
}

export interface GoalDetail {
  goal: Goal;
  research: Task | null;
  tasks: Task[];
}

export interface GoalSummary extends Pick<Goal, "id" | "title" | "repoId" | "status"> {
  taskCount: number;
}

/** Where a goal's task stands, in the order an operator should look at them. */
export const GOAL_TASK_PHASES = ["stopped", "review", "working", "waiting", "done"] as const;
export type GoalTaskPhase = (typeof GOAL_TASK_PHASES)[number];
export type GoalProgress = Record<GoalTaskPhase, number>;

/** A row on the Goals page: its summary, and how far its work has got. */
export interface GoalListItem extends GoalSummary {
  /** Tasks in the current plan, which exist before approval creates any. */
  plannedTasks: number;
  progress: GoalProgress;
}

/** Done means its dependents can start, so an approved branch still waiting to merge needs the operator. */
export function goalTaskPhase(task: Pick<Task, "status" | "branch">): GoalTaskPhase {
  if (prerequisiteMet(task)) return "done";
  switch (task.status) {
    case "running":
    case "merging":
      return "working";
    case "queued":
      return "waiting";
    case "failed":
    case "cancelled":
    case "rejected":
      return "stopped";
    default:
      return "review";
  }
}

export function goalProgress(tasks: Pick<Task, "status" | "branch">[]): GoalProgress {
  const progress: GoalProgress = { stopped: 0, review: 0, working: 0, waiting: 0, done: 0 };
  for (const task of tasks) progress[goalTaskPhase(task)]++;
  return progress;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a goal plan object");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} must be text between 1 and ${max} characters`);
  }
  return value.trim();
}

function texts(value: unknown, label: string, max: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a list of at most ${max} entries`);
  return [...new Set(value.map((v) => text(v, label, length)))];
}

/** Validate untrusted research and operator edits before they can become runnable work. */
export function validateGoalPlan(value: unknown): GoalPlan {
  const raw = record(value);
  if (!Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > 40) throw new Error("A goal needs 1 to 40 tasks");
  const tasks = raw.tasks.map((value): GoalTask => {
    const t = record(value);
    const key = text(t.key, "Task key", 40);
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error("Task keys use lowercase letters, numbers and hyphens, starting with a letter");
    if (!isDriverName(t.driver)) throw new Error(`Unknown agent for ${key}`);
    const model = t.model == null ? null : text(t.model, "Model", 120);
    if (model && !/^[A-Za-z0-9][\w.:/@[\]-]{0,119}$/.test(model)) throw new Error(`Invalid model for ${key}`);
    const effort = t.effort == null ? null : text(t.effort, "Effort", 20);
    if (effort && !EFFORT_LEVELS[t.driver].includes(effort)) throw new Error(`Invalid effort for ${t.driver}`);
    const acceptance = texts(t.acceptance, "Acceptance criteria", 20, 500);
    if (!acceptance.length) throw new Error(`Give ${key} at least one acceptance criterion`);
    return { key, title: text(t.title, "Task title", 200), brief: text(t.brief, "Task brief", 20000),
      dependsOn: texts(t.dependsOn, "Dependencies", 20, 40), driver: t.driver, model, effort,
      rationale: text(t.rationale, "Agent and ordering rationale", 4000), acceptance,
      acceptanceChecks: texts(t.acceptanceChecks ?? [], "Acceptance checks", 20, 500) };
  });
  const keys = new Set(tasks.map((t) => t.key));
  if (keys.size !== tasks.length) throw new Error("Task keys must be unique");
  for (const task of tasks) {
    if (task.dependsOn.some((key) => !keys.has(key) || key === task.key)) throw new Error(`Unknown or self dependency in ${task.key}`);
  }
  const plan = { summary: text(raw.summary, "Plan summary", 4000), approach: text(raw.approach, "Approach", 20000),
    improvements: texts(raw.improvements, "Improvements", 40, 4000), tasks };
  goalWaves(plan); // rejects cycles
  return plan;
}

/** Tasks within a wave may run together; dependencies must land before the next wave. */
export function goalWaves(plan: GoalPlan): GoalTask[][] {
  const remaining = new Set(plan.tasks.map((t) => t.key));
  const waves: GoalTask[][] = [];
  while (remaining.size) {
    const wave = plan.tasks.filter((t) => remaining.has(t.key) && t.dependsOn.every((key) => !remaining.has(key)));
    if (!wave.length) throw new Error("Goal dependencies contain a cycle");
    waves.push(wave);
    wave.forEach((t) => remaining.delete(t.key));
  }
  return waves;
}
