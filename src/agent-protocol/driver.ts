import type { EventType, Task, Report, Repo, RunUsage } from "@crane/contracts";

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
   * A session from an earlier run of this task that was interrupted, because
   * the factory restarted or the API had a transient failure. The driver
   * continues it, with its history, instead of starting over. If it can't, it
   * starts a fresh session.
   */
  resumeSession?: string;
  /** Called with the driver's session id as soon as it has one, so an interrupted run can be resumed. */
  onSession?: (sessionId: string) => void;
  /**
   * Call with what the run used as soon as it's known, before resolving or
   * rejecting. A run that fails still costs money, so report it then too.
   */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Commands Crane runs itself once the agent finishes (the repo's configured
   * checks). The agent is told about them, so a check its environment refuses
   * is left to Crane rather than reported as a gap.
   */
  checks?: string[];
  /** Extra permission rules the operator allowed for this repo. Crane's deny list still wins. */
  allowedTools?: string[];
  /** Stop the agent after this many turns. */
  maxTurns?: number;
  /** The model the operator chose for this agent. Unset leaves it to the driver's own default. */
  model?: string;
  /** The effort level the operator chose for this agent, one of `EFFORT_LEVELS` for it. */
  effort?: string;
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

/**
 * A run that ended badly: whether trying again is likely to work, and the
 * session to continue if so. What it cost goes through `RunContext.onUsage`.
 *
 * Defined here and nowhere else: retry handling checks `instanceof`, so every
 * old import path must re-export this class rather than declare its own.
 */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly opts: {
      transient?: boolean;
      sessionId?: string | null;
      /** Set when the run stopped because it used up its turns. */
      limit?: "turns";
    } = {},
  ) {
    super(message);
    this.name = "AgentRunError";
  }
  get transient() {
    return !!this.opts.transient;
  }
  get sessionId() {
    return this.opts.sessionId ?? null;
  }
}

/**
 * Failures worth one more try: the API was overloaded, rate limited, or
 * briefly unreachable. Plan usage limits are not: they reset hours later.
 */
export function isTransientFailure(message: string): boolean {
  if (/usage limit|hit your limit|limit reached|credit balance|quota/i.test(message)) return false;
  return /API Error:?\s*(429|5\d\d)\b|\b(overloaded|overloaded_error|rate[ _]limit(ed)?|rate_limit_error|api_error)\b|\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b|socket hang up|fetch failed|request timed out|temporarily unavailable/i.test(
    message,
  );
}

/** Anything that can work a task. Swap drivers without touching the factory. */
export interface AgentDriver {
  readonly name: string;
  /** Human-readable label for the UI, e.g. "Claude Code". */
  readonly label: string;
  available(): Promise<boolean>;
  run(ctx: RunContext): Promise<RunResult>;
}
