/** Dashboard analytics and aggregate HTTP response shapes. */
import type { Agent } from "./crew.js";
import type { BlockedTool, TaskEvent } from "./events.js";
import type { GoalSummary } from "./goals.js";
import type { Repo, RepoTools } from "./repo.js";
import type { AgentRun } from "./runs.js";
import type { FollowUpSource, FollowUpState, PrerequisiteState, Task, TaskKind, TaskStatus, TaskSummary } from "./task.js";

/** Null keeps all history. Choosing days authorizes irreversible routine-history cleanup. */
export interface RetentionSettings {
  finishedTaskDays: number | null;
}

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
  /** Runs whose cost is missing in whole or in part; excluded amounts are not free. */
  unknownCostRuns: number;
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
  /** Per-run driver attribution; a task can count under more than one agent. Includes zero-cost runs. */
  byAgent: (SpendSlice & { driver: string })[];
  /** The most expensive tasks in the window, by what they cost in it. */
  topTasks: (Pick<Task, "id" | "title" | "status" | "kind" | "repoId"> & { usd: number; runs: number })[];
}

export interface Overview {
  factory: {
    running: boolean;
    paused: boolean;
    driver: string;
    /** The running backend is older than its source; rebuild and restart the factory to load changes. */
    factoryOutdated: boolean;
    /** The served dashboard is older than its source, so recent UI changes won't show until a rebuild. */
    uiOutdated: boolean;
    /** Identifies the dashboard being served. When it changes, a newer build has replaced it. */
    uiBuild: string | null;
    /** The commit Crane built the served dashboard from, or null when it's the checkout's own web/dist. */
    uiCommit: string | null;
  };
  counts: Record<TaskStatus, number>;
  /** Unassigned queued tasks whose start time has arrived; not capped by inFlight. */
  queuedForAnyone: number;
  shippedThisWeek: number;
  shippedLastWeek: number;
  spendThisWeekUsd: number;
  /** One bucket per hour for the last 7 days: completed tasks and agent events. */
  activity: { t: string; done: number; events: number }[];
  needsReview: TaskSummary[];
  goalsNeedingReview?: GoalSummary[];
  inFlight: TaskSummary[];
  recent: TaskSummary[];
  agents: Agent[];
  repos: (Repo & { openTasks: number; tools: RepoTools })[];
  /** Commands agents keep getting refused, in more than one task, that the operator hasn't decided on yet. */
  blocked: BlockedTool[];
}

/** One task with everything its page shows: `GET /api/tasks/:id`. */
export interface TaskDetail {
  goalId?: string | null;
  task: Task;
  repo: Repo | null;
  /** Who's working it, or, before it's picked up, the crew member it was started for. */
  agent: Agent | null;
  events: TaskEvent[];
  runs: AgentRun[];
  /** Commands this task was blocked from that still wait on a decision, counted across the repo. */
  blocked: BlockedTool[];
  /** The task's prerequisites, in the order it lists them, and whether each has landed. */
  prerequisites: PrerequisiteState[];
  /** Tasks started from this task's findings, oldest first. */
  followUps: FollowUpState[];
  /** The task whose finding this one was started from, or null when it isn't a follow-up. */
  followUpSource: FollowUpSource | null;
}
