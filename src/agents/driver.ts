import type { EventType, Task, Report, Repo, RunUsage } from "../core/types.js";

export interface RunContext {
  task: Task;
  repo: Repo | null;
  /** Directory the agent works in: the repo itself (observe) or an isolated worktree. */
  cwd: string;
  signal: AbortSignal;
  emit: (type: EventType, message: string, data?: Record<string, unknown>) => void;
  /** Set when the run is a narrower job than working the task itself. */
  job?: AgentJob;
  /**
   * A session from an earlier run of this task that was interrupted, usually
   * because the factory restarted. The driver continues it, with its history,
   * instead of starting over. If it can't, it starts a fresh session.
   */
  resumeSession?: string;
  /** Called with the driver's session id as soon as it has one, so an interrupted run can be resumed. */
  onSession?: (sessionId: string) => void;
  /**
   * Call with what the run used as soon as it's known, before resolving or
   * rejecting. A run that fails still costs money, so report it then too.
   */
  onUsage?: (usage: RunUsage) => void;
}

/**
 * Resolve the conflicts of a merge Crane has already started in `cwd`: the
 * task branch merging into `base`. The agent edits and stages files only;
 * Crane checks the result, commits, and pushes.
 */
export interface ResolveConflictsJob {
  kind: "resolve_conflicts";
  /** What the task branch is being merged into, e.g. `origin/main`. */
  base: string;
  files: string[];
}

export type AgentJob = ResolveConflictsJob;

export interface RunResult {
  report: Report;
}

/** Anything that can work a task. Swap drivers without touching the factory. */
export interface AgentDriver {
  readonly name: string;
  /** Human-readable label for the UI, e.g. "Claude Code". */
  readonly label: string;
  available(): Promise<boolean>;
  run(ctx: RunContext): Promise<RunResult>;
}
