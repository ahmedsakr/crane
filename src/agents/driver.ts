import type { EventType, Mission, Report, Repo } from "../core/types.js";

export interface RunContext {
  mission: Mission;
  repo: Repo | null;
  /** Directory the agent works in: the repo itself (observe) or an isolated worktree. */
  cwd: string;
  signal: AbortSignal;
  emit: (type: EventType, message: string, data?: Record<string, unknown>) => void;
}

export interface RunResult {
  report: Report;
  costUsd: number;
}

/** Anything that can work a mission. Swap drivers without touching the factory. */
export interface AgentDriver {
  readonly name: string;
  /** Human-readable label for the UI, e.g. "Claude Code". */
  readonly label: string;
  available(): Promise<boolean>;
  run(ctx: RunContext): Promise<RunResult>;
}
