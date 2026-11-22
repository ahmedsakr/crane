/**
 * Crane containers (runners): compute an operator registers so their tasks'
 * agents run on their own Claude Code and Codex sign-ins. These are the shapes
 * the factory, a container (`crane runner start`) and the dashboard agree on.
 * Crane stores only a digest of a container's token, so none of them carry one.
 */
import type { DriverName } from "./drivers.js";
import type { CommandAccess } from "./repo.js";
import type { CommandEvidence, TaskEvent } from "./events.js";
import type { RunUsage } from "./runs.js";
import type { Autonomy, PrerequisiteState, Task } from "./task.js";

/** A registered container, as operators see it. Never includes its token. */
export interface RunnerSummary {
  id: string;
  /** The owner's name for it, e.g. `laptop`. */
  name: string;
  /** The operator who registered it; only they can route work to it. */
  ownerId: string;
  /** The owner's name as it is now. */
  ownerName: string;
  /** How many jobs it runs at once. */
  capacity: number;
  /** The agents it reported signed in at its last heartbeat. */
  drivers: DriverName[];
  /** Whether it has sent a heartbeat recently (see `isRunnerOnline`). */
  online: boolean;
  /** Its last heartbeat, or null if it has never connected. */
  lastSeenAt: string | null;
  createdAt: string;
  /** Jobs it has claimed and not yet returned. */
  busy: number;
}

/** What a container job asks for: a task's own work or one of its merge runs. */
export const RUNNER_JOB_KINDS = ["work", "observe", "resolve_conflicts", "fix_checks"] as const;
export type RunnerJobKind = (typeof RUNNER_JOB_KINDS)[number];

/** Where a job stands. Only `queued` and `claimed` are still open. */
export const RUNNER_JOB_STATES = ["queued", "claimed", "returned", "cancelled", "failed", "expired"] as const;
export type RunnerJobState = (typeof RUNNER_JOB_STATES)[number];

/** The only event types Crane accepts from a container; status and operator events stay its own. */
export const RUNNER_EVENT_TYPES = ["note", "tool", "finding", "error", "blocked"] as const;
export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];

/** Size and timing bounds for the container protocol. The server enforces them on everything it receives. */
export const RUNNER_LIMITS = {
  /** Longest event message accepted; longer ones are cut. */
  eventMessageChars: 4000,
  /** Most events in one batch. */
  eventsPerBatch: 200,
  /** Largest commit bundle or tree a container may return. */
  bundleBytes: 256 * 1024 * 1024,
  /** Largest screenshot upload, matching what Crane retains with a task. */
  screenshotBytes: 10 * 1024 * 1024,
  /** Most screenshots per job, matching what Crane retains with a task. */
  screenshotCount: 12,
  /** How long a claimed job stays leased without a heartbeat before it expires. */
  leaseSeconds: 300,
  /** How often a container sends a heartbeat. */
  heartbeatSeconds: 15,
  /** A container that hasn't sent a heartbeat for this long reads as offline. */
  offlineAfterSeconds: 60,
} as const;

/** A container's periodic check-in: what it can run right now. */
export interface RunnerHeartbeat {
  /** The agents signed in on the container. */
  drivers: DriverName[];
  capacity: number;
  /** The container's Crane version. */
  version: string;
  /** Ids of the jobs it is running, so their leases are renewed. Any no longer leased to it come back in `cancel`. */
  jobs?: string[];
}

/** The server's answer to a heartbeat. */
export interface RunnerHeartbeatReply {
  /** Ids of claimed jobs the container should stop. */
  cancel: string[];
}

/** Another task in the repo, as a job brief carries it. Mirrors agent-protocol's `SiblingTask`. */
export interface RunnerSiblingTask extends Pick<Task, "id" | "title" | "status" | "branch"> {
  hasCommits: boolean | null;
}

/** One failed merge check shown to a `fix_checks` job. Mirrors agent-protocol's `FailedCheck`. */
export interface RunnerFailedCheck {
  command: string;
  exitCode: number | null;
  logs: string;
}

/**
 * The narrower brief of a `resolve_conflicts` or `fix_checks` job. Mirrors
 * agent-protocol's `AgentJob`, which contracts can't import.
 */
export type RunnerAgentJob =
  | {
    kind: "resolve_conflicts";
    phase?: "edit" | "validate";
    checkpoint?: string;
    base: string;
    files: string[];
    deferredDependencies?: string[];
  }
  | { kind: "fix_checks"; base: string; commit: string; failures: RunnerFailedCheck[] };

/** A job a container claims. Paths are never included: the container works in its own directories. */
export interface RunnerJob {
  id: string;
  kind: RunnerJobKind;
  taskId: string;
  title: string;
  autonomy: Autonomy;
  repo: { id: string; name: string; defaultBranch: string };
  /**
   * The task as the agent is briefed on it, with Crane's own worktree path
   * removed. The container's driver builds its prompt from this.
   */
  task: Task;
  /**
   * The commit the branch left the default branch at (a work or observe job),
   * the default commit being merged into (resolve_conflicts) or the merge
   * commit that failed its checks (fix_checks).
   */
  base: string;
  /** The task branch to work on, or null for an investigate-only run. */
  branch: string | null;
  /**
   * The branch's current commit when it already has work, or null. A work job
   * starts from `tip ?? base`, and Crane accepts only fast-forwards of it.
   */
  tip: string | null;
  driver: DriverName;
  model?: string;
  effort?: string;
  maxTurns?: number;
  /** A session from an earlier run of this task to continue. */
  resumeSession?: string;
  job?: RunnerAgentJob;
  checks?: string[];
  siblingTasks?: RunnerSiblingTask[];
  prerequisites?: PrerequisiteState[];
  postmortemPrompt?: string;
  commandEvidence?: CommandEvidence[];
  priorRefusals?: TaskEvent[];
  allowedTools?: string[];
  commandAccess?: CommandAccess;
  dependencyProblem?: string;
  /** When the lease ends unless a heartbeat renews it. */
  leaseExpiresAt: string;
}

/** Events a container streams back while a job runs. Untrusted: the server filters and caps them. */
export interface RunnerEventBatch {
  events: { type: RunnerEventType; message: string; data?: Record<string, unknown> }[];
}

/**
 * How a job ended. The server parses `finalText` for the report itself and
 * never takes validation from a container.
 */
export interface RunnerResult {
  outcome: "succeeded" | "failed";
  /** The agent's raw final message. */
  finalText?: string;
  error?: { message: string; transient: boolean; limit?: "turns" };
  sessionId?: string | null;
  usage?: RunUsage;
}

/**
 * Whether a container sent a heartbeat within `RUNNER_LIMITS.offlineAfterSeconds`
 * of `now`. Never seen or an unreadable time is offline; a time slightly ahead
 * of `now` (clock skew) is online.
 */
export function isRunnerOnline(lastSeenAt: string | null, now: number | Date = Date.now()): boolean {
  if (lastSeenAt == null) return false;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return false;
  return +now - seen <= RUNNER_LIMITS.offlineAfterSeconds * 1000;
}

/** How copy names a container, e.g. "Robin's container 'laptop'". */
export function runnerLabel(runner: Pick<RunnerSummary, "name" | "ownerName">): string {
  return `${runner.ownerName}'s container '${runner.name}'`;
}
