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
  /**
   * The agent's own session for this task, recorded as soon as it starts. If
   * the factory restarts mid-task, the next agent picks this session up again
   * instead of starting over.
   */
  sessionId: string | null;
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

/** Why an agent ran: to work the task itself, or to resolve a merge's conflicts. */
export type RunKind = "work" | "resolve_conflicts";
export type RunOutcome = "running" | "succeeded" | "failed" | "cancelled";

/** What one agent run used, as its driver reported it. */
export interface RunUsage {
  /** Claude Code's figure, at API prices. On a subscription it's an estimate, not a bill. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  /** The model that did most of the work, when the driver knows. */
  model: string | null;
}

/**
 * One agent run against a task. A task can have several: a run per attempt
 * (a factory restart re-runs it) plus any conflict resolution while merging.
 * The task's `costUsd` is the sum of its runs.
 */
export interface AgentRun extends RunUsage {
  id: number;
  taskId: string;
  kind: RunKind;
  agentId: string | null;
  driver: string;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string | null;
}

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  work: "Work",
  resolve_conflicts: "Resolve conflicts",
};

/** Statuses where the work was thrown away, so what it cost bought nothing that shipped. */
export const UNSHIPPED_STATUSES: TaskStatus[] = ["failed", "cancelled", "rejected"];

export interface SpendSlice {
  usd: number;
  tasks: number;
}

/** Spend over a window of days, attributed to when each run finished. */
export interface Analytics {
  days: number;
  from: string;
  to: string;
  spendUsd: number;
  /** The same number of days just before `from`. */
  prevSpendUsd: number;
  runs: number;
  /** Tasks with at least one run in the window. */
  tasks: number;
  /** Tasks that were done, approved, or merged. */
  shipped: SpendSlice;
  /** Tasks that failed, were cancelled, or were declined. */
  unshipped: SpendSlice;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** One bucket per local day, oldest first. `day` is the local midnight it starts at. */
  daily: { day: string; usd: number; runs: number }[];
  byRepo: (SpendSlice & { repoId: string | null; name: string })[];
  byKind: (SpendSlice & { kind: TaskKind })[];
  /** The most expensive tasks in the window, by what they cost in it. */
  topTasks: (Pick<Task, "id" | "title" | "status" | "kind" | "repoId"> & { usd: number; runs: number })[];
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
