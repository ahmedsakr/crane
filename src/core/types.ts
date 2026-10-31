/**
 * Crane's domain model.
 *
 * The operator (a human) issues Missions. Agents pick missions up and work them
 * inside a target Repo. What comes back is a stream of Events and, at the end,
 * a Report with Findings. Anything that would change code is held behind the
 * mission's autonomy level so the operator stays in control.
 */

/** What kind of work a mission is. */
export type MissionKind =
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

export type MissionStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "approved"
  | "rejected"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_STATUSES: MissionStatus[] = ["queued", "running"];
export const TERMINAL_STATUSES: MissionStatus[] = ["approved", "rejected", "done", "failed", "cancelled"];

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  /** True for the repo Crane itself lives in, used for factory_feature missions. */
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

export interface Mission {
  id: string;
  kind: MissionKind;
  title: string;
  brief: string;
  repoId: string | null;
  autonomy: Autonomy;
  status: MissionStatus;
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

export interface MissionEvent {
  id: number;
  missionId: string;
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
  missionId: string | null;
  driver: string;
  missionsCompleted: number;
  lastActiveAt: string | null;
}

export interface NewMission {
  kind: MissionKind;
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
  counts: Record<MissionStatus, number>;
  shippedThisWeek: number;
  shippedLastWeek: number;
  spendThisWeekUsd: number;
  /** One bucket per hour for the last 7 days: completed missions and agent events. */
  activity: { t: string; done: number; events: number }[];
  needsReview: Mission[];
  inFlight: Mission[];
  recent: Mission[];
  agents: Agent[];
  repos: (Repo & { openMissions: number })[];
}

export const KIND_LABEL: Record<MissionKind, string> = {
  maintenance: "Maintenance",
  repo_feature: "Repo feature",
  factory_feature: "Factory feature",
};

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  observe: "Investigate only",
  propose: "Change, then ask me",
  act: "Change on a branch",
};

export const STATUS_LABEL: Record<MissionStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_review: "Needs you",
  approved: "Approved",
  rejected: "Declined",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
