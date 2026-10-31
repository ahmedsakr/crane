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
 * Crane never pushes or merges into a default branch on its own. That only
 * happens when the operator approves and merges a task (see `merging`).
 */
export type Autonomy = "observe" | "propose" | "act";

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "approved"
  /** Approved and waiting for, or in the middle of, landing on the default branch. */
  | "merging"
  /** Landed on the default branch (and pushed, when the repo has a remote). */
  | "merged"
  | "rejected"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "merging"];
export const TERMINAL_STATUSES: TaskStatus[] = ["approved", "merged", "rejected", "done", "failed", "cancelled"];
export const ALL_STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "needs_review",
  "approved",
  "merging",
  "merged",
  "rejected",
  "done",
  "failed",
  "cancelled",
];
/** Statuses that count as shipped work. */
export const SHIPPED_STATUSES: TaskStatus[] = ["done", "approved", "merged"];

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
  | "blocked" // a tool call the agent's permissions refused; data is a BlockedCall
  | "operator"; // something the operator did

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: string;
  type: EventType;
  message: string;
  data: Record<string, unknown> | null;
}

/** What a `blocked` event carries: the refused call, and the rules that would have let it through. */
export interface BlockedCall {
  tool: string;
  /** The Bash command, when the tool was Bash. */
  command?: string;
  /**
   * Permission rules (e.g. `Bash(npm ci:*)`) that would have allowed the call.
   * Empty when it was refused on purpose (ALWAYS_DENIED, or a write in an
   * investigate-only task) or Crane has nothing safe to suggest.
   */
  rules: string[];
}

/**
 * A rule an agent was refused in one repo, added up across its tasks, so the
 * operator can allow it once instead of rediscovering it in every task.
 */
export interface BlockedTool {
  repoId: string;
  repoName: string;
  /** The permission rule to allow, e.g. `Bash(npm ci:*)`. */
  rule: string;
  /** What the operator reads: `npm ci`. */
  label: string;
  /** How many tasks hit it, and how many times in all. */
  tasks: number;
  times: number;
  lastAt: string;
  /** The most recent task that hit it. */
  lastTaskId: string;
}

/** Tool rules the operator has decided on for one repo. */
export interface RepoTools {
  /** Allowed for every agent working in this repo, on top of Crane's defaults. */
  allowed: string[];
  /** Blocked rules the operator chose to keep blocked, so Crane stops asking. */
  keptBlocked: string[];
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
    /** The served dashboard is older than its source, so recent UI changes won't show until a rebuild. */
    uiOutdated: boolean;
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
  repos: (Repo & { openTasks: number; tools: RepoTools })[];
  /** Commands agents keep getting refused, in more than one task, that the operator hasn't decided on yet. */
  blocked: BlockedTool[];
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
  merging: "Merging",
  merged: "Merged",
  rejected: "Declined",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * What the last merge attempt left behind, carried on its status event so the
 * UI and CLI can explain it. A failed attempt sends the task back to the
 * operator with `error` set.
 */
export interface MergeOutcome {
  error?: string;
  /** The commit that landed on the default branch. */
  commit?: string;
  /** The remote it was pushed to, or null when the repo has none. */
  pushedTo?: string | null;
  /** A checkout of the default branch Crane left alone (it had local changes), so the operator can catch up. */
  checkoutBehind?: string | null;
}

/** The merge outcome on the task's latest status event, if that status came from a merge. */
export function lastMergeOutcome(events: TaskEvent[]): MergeOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "status") return (e.data?.merge as MergeOutcome | undefined) ?? null;
  }
  return null;
}
