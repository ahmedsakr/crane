/** Task lifecycle, scheduling and operator inputs. */
import type { DriverSettings } from "./drivers.js";
import type { Lookout } from "./lookouts.js";
import type { Report, ReviewCheckpoint, VisualReview } from "./report.js";

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

/** Statuses where something is waiting to run or running: an agent's work, or a merge. */
export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "merging"];

/** Statuses where the work is over. Nothing more runs unless the operator merges or retries it. */
export const FINISHED_STATUSES: TaskStatus[] = ["approved", "merged", "rejected", "done", "failed", "cancelled"];

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

export interface Task {
  /** Factory-owned candidate and operator-owned visual decision. Null/absent requires review. */
  visualReview?: VisualReview | null;
  /** Present from finalization until the work run hands the task over. */
  reviewCheckpoint?: ReviewCheckpoint | null;
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
  /**
   * The agent the operator chose for this task, e.g. `codex`. Null means the
   * factory's default agent at the time it's picked up.
   */
  driver: string | null;
  /** Task overrides; null follows the chosen agent's saved settings. */
  model: string | null;
  effort: string | null;
  /** Saved overrides for an automatic post-mortem. Null follows the agent's settings. */
  driverSettings: DriverSettings | null;
  /**
   * The crew member this task is for, e.g. `a-jib`, when the operator started
   * it from that member's maintenance role. Only that member picks it up.
   * Null means whoever is free next.
   */
  assignee: string | null;
  /**
   * The merged task this post-mortem reviews, kept across retries. Null for any
   * other task. Post-mortems go to the crew named in `PostmortemSettings.crew`.
   */
  postmortemOf: string | null;
  /**
   * When the operator pre-approved this task, before it reached review. Once
   * its run finishes and its checks pass, it goes straight to the merge queue
   * instead of waiting for them. Also authorizes Crane to waive visual review
   * for this task, including conflict resolutions. Null means review as usual.
   */
  preApprovedAt: string | null;
  /**
   * Tasks that must land first (see `prerequisiteMet`). Crane doesn't start
   * this one until they have, unless the operator waives them.
   */
  prerequisites: string[];
  /**
   * When the operator waived the prerequisites that hadn't landed, approving a
   * reduced scope so the task could start without them. Null if never waived.
   */
  prerequisitesWaivedAt: string | null;
  /**
   * Observable conditions the work must meet. A pre-approved task merges on
   * its own only when its report shows every one of them met.
   */
  acceptance: string[];
  /**
   * Configured repo checks the work must pass, by exact command. Only Crane's
   * own passing results for the candidate meet them (see `acceptanceCheckRun`),
   * so the agent never reports on them. Criterion text is never read as one.
   */
  acceptanceChecks: string[];
  /**
   * Opportunities the operator asked the agent to also look out for while it
   * works the task (see `LOOKOUT`). They don't widen the task: the agent
   * reports what it finds as findings. Empty when none were asked for.
   */
  lookouts: Lookout[];
  report: Report | null;
  costUsd: number;
  createdAt: string;
  /** Earliest pickup time, in UTC. Null means immediately eligible; prerequisites still apply. */
  scheduledAt: string | null;
  /** Recurring crew schedule that started this run, retained after removal. */
  scheduleId: string | null;
  /** The task whose finding the operator turned into this one, or null. */
  followUpOf: string | null;
  /**
   * Which of that task's findings (0-based) it acts on. Null when it isn't a
   * follow-up, or for an older follow-up whose finding Crane couldn't match.
   */
  followUpFinding: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Lightweight task-list and overview payload; full briefs and reports stay on task detail. */
export interface TaskSummary extends Pick<Task,
  "id" | "kind" | "title" | "repoId" | "status" | "branch" | "assignee" | "postmortemOf" |
  "createdAt" | "scheduledAt" | "startedAt" | "finishedAt"
> {
  reportSummary: string | null;
  findingCount: number;
  changedFileCount: number;
}

export interface TaskRunOptions {
  /** Which agent works it. Null uses the factory's default. */
  driver?: string | null;
  /** Overrides for this task only; null follows the agent's saved settings. */
  model?: string | null;
  effort?: string | null;
}

export interface NewTask extends TaskRunOptions {
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  /** Earliest pickup time: a future ISO 8601 timestamp with a timezone, or null for now. */
  scheduledAt?: string | null;
  /** Merge once the run and checks pass, without waiting for review. */
  preApprove?: boolean;
  /** The crew member who must work it. Leave out for whoever is free next. */
  assignee?: string | null;
  /** Ids of tasks in the same repo that must land before this one starts. */
  prerequisites?: string[];
  /** Observable conditions the work must meet before it can merge without review. */
  acceptance?: string[];
  /** Configured repo checks that must pass on the candidate, by exact command. */
  acceptanceChecks?: string[];
  /** What else the agent should look out for while it works. */
  lookouts?: Lookout[];
}

/** A queued task still waiting for its start time. Due tasks read as queued again. */
export const isScheduled = (task: Pick<Task, "status" | "scheduledAt">, now = Date.now()): boolean =>
  task.status === "queued" && task.scheduledAt != null && Date.parse(task.scheduledAt) > now;

/** What a follow-up can add to the run options: the gates it must pass. */
export type TaskGates = Pick<NewTask, "prerequisites" | "acceptance" | "acceptanceChecks">;

/**
 * Whether a prerequisite has landed: merged into the default branch, or
 * finished without a branch, so there's nothing of it left to merge.
 * Approved or done with a branch kept isn't landed yet.
 */
export const prerequisiteMet = (t: Pick<Task, "status" | "branch">): boolean =>
  t.status === "merged" || ((t.status === "done" || t.status === "approved") && !t.branch);

/** A prerequisite as a task's page and CLI show it. */
export interface PrerequisiteState extends Pick<Task, "id" | "title" | "status"> {
  met: boolean;
}

/** A task started from one of another task's findings, as that task's page and CLI show it. */
export interface FollowUpState extends Pick<Task, "id" | "title" | "status"> {
  /** The finding it acts on (0-based), or null when Crane couldn't tell which. */
  finding: number | null;
}

/** The task and finding a follow-up came from, as the follow-up's page and CLI show it. */
export interface FollowUpSource extends Pick<Task, "id" | "title" | "status"> {
  /** The finding's title, or null when Crane couldn't tell which finding, or the source's report no longer has it. */
  finding: string | null;
}

/** The most recent follow-up started from finding `index`, if any. */
export const followUpFor = (followUps: readonly FollowUpState[], index: number): FollowUpState | undefined =>
  followUps.filter((f) => f.finding === index).at(-1);

/** Statuses where the work was thrown away, so what it cost bought nothing that shipped. */
export const UNSHIPPED_STATUSES: TaskStatus[] = ["failed", "cancelled", "rejected"];

/** What a task changed: `GET /api/tasks/:id/diff`. */
export interface TaskDiff {
  /** A unified diff against the default branch, or "" when there's nothing to show. */
  diff: string;
  /** True while the task runs: the diff is read from its worktree, uncommitted work included, and keeps changing. */
  live: boolean;
}

/** Crane's reading of a plain-language instruction: `POST /api/instruct/draft`. */
export interface TaskDraft {
  kind: TaskKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  /** Short reasons for each guess, shown to the operator so they can correct them. */
  why: { kind: string; repo: string; autonomy: string };
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
