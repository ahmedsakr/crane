import type { EventType, Task, Report, Repo } from "../core/types.js";

export interface RunContext {
  task: Task;
  repo: Repo | null;
  /** Directory the agent works in: the repo itself (observe) or an isolated worktree. */
  cwd: string;
  signal: AbortSignal;
  emit: (type: EventType, message: string, data?: Record<string, unknown>) => void;
  /** Set when the run is a narrower job than working the task itself. */
  job?: AgentJob;
  /** Extra permission rules the operator allowed for this repo. Crane's deny list still wins. */
  allowedTools?: string[];
  /** Stop the agent after this many turns. */
  maxTurns?: number;
  /** Continue this agent session instead of starting over (after a transient failure). */
  resume?: string;
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
  costUsd: number;
}

/**
 * A run that ended badly. Carries what it cost, so failed runs still count
 * toward spend, and whether trying again later is likely to work.
 */
export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly opts: {
      transient?: boolean;
      costUsd?: number;
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
  get costUsd() {
    return this.opts.costUsd ?? 0;
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
