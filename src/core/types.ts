/**
 * Crane's domain model.
 *
 * The operator (a human) issues Tasks. Agents pick tasks up and work them
 * inside a target Repo. What comes back is a stream of Events and, at the end,
 * a Report with Findings. Anything that would change code is held behind the
 * task's autonomy level so the operator stays in control.
 */

/** What kind of work a task is. */
export type TaskKind =
  /** Keep an existing codebase healthy: bugs, flaky tests, deps, security, cleanup. */
  | "maintenance"
  /** Research or build a new capability into a target repo. */
  | "repo_feature"
  /** Research or build a new capability into Crane itself. */
  | "factory_feature";

/**
 * How far an agent may go on its own.
 * - observe: read-only. Investigates and reports back.
 * - propose: makes changes on an isolated branch, then waits for the operator.
 * - act: makes changes on an isolated branch and finishes without waiting.
 *   Crane never pushes or merges into a default branch on its own.
 */
export type Autonomy = "observe" | "propose" | "act";

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "approved"
  | "rejected"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running"];
export const TERMINAL_STATUSES: TaskStatus[] = ["approved", "rejected", "done", "failed", "cancelled"];

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  /** True for the repo Crane itself lives in, used for factory_feature tasks. */
  isFactory: boolean;
  addedAt: string;
}

export interface Finding {
  title: string;
  detail: string;
  /** How much this matters, from the agent's point of view. */
  impact: "low" | "medium" | "high";
  /** Rough size of the work to act on it. */
  effort: "small" | "medium" | "large";
}

export interface Report {
  summary: string;
  findings: Finding[];
  /** Files the agent changed, when it was allowed to change any. */
  changedFiles: string[];
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  status: TaskStatus;
  agentId: string | null;
  branch: string | null;
  worktree: string | null;
  report: Report | null;
  costUsd: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type EventType =
  | "status" // lifecycle change
  | "note" // the agent's narration
  | "tool" // the agent used a tool
  | "finding" // something worth the operator's attention
  | "error"
  | "operator"; // something the operator did

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: string;
  type: EventType;
  message: string;
  data: Record<string, unknown> | null;
}

export type AgentState = "idle" | "working" | "paused";

export interface Agent {
  id: string;
  name: string;
  state: AgentState;
  taskId: string | null;
  driver: string;
  tasksCompleted: number;
  lastActiveAt: string | null;
}

export interface NewTask {
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
}

export interface Overview {
  factory: {
    running: boolean;
    paused: boolean;
    driver: string;
  };
  counts: Record<TaskStatus, number>;
  shippedThisWeek: number;
  shippedLastWeek: number;
  spendThisWeekUsd: number;
  /** One bucket per hour for the last 7 days: completed tasks and agent events. */
  activity: { t: string; done: number; events: number }[];
  needsReview: Task[];
  inFlight: Task[];
  recent: Task[];
  agents: Agent[];
  repos: (Repo & { openTasks: number })[];
}

export const KIND_LABEL: Record<TaskKind, string> = {
  maintenance: "Maintenance",
  repo_feature: "Repo feature",
  factory_feature: "Factory feature",
};

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  observe: "Investigate only",
  propose: "Change, then ask me",
  act: "Change on a branch",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_review: "Needs you",
  approved: "Approved",
  rejected: "Declined",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
