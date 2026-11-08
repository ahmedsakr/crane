/** Task history and driver command/refusal evidence. */

export type EventType =
  | "status" // lifecycle change
  | "note" // the agent's narration
  | "tool" // the agent used a tool
  | "finding" // something worth the operator's attention
  | "error"
  | "blocked" // a tool call the agent's permissions refused; data is a BlockedCall
  | "operator";

// something the operator did

/** Persisted agent command evidence; exitCode is null until actually received. */
export interface CommandEvidence {
  commandId: string;
  itemId: string | null;
  sessionId: string | null;
  command: string;
  truncated: boolean;
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  exitCode: number | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  ts: string;
  type: EventType;
  message: string;
  data: Record<string, unknown> | null;
}

/** What a `blocked` event carries: the refused call, evidence, and suggested rules. */
export interface BlockedCall {
  tool: string;
  /** Driver call id, for correlating live refusals with end-of-run records. */
  toolUseId?: string;
  /**
   * Driver evidence, not a policy decision inferred from rule suggestions.
   * Optional for older events and drivers without refusal evidence.
   */
  refusal?: {
    /** `crane.guard` identifies Crane's hook; `claude.auto-mode` identifies Claude Code's classifier. */
    source: "claude-code.tool_result" | "claude-code.permission_denials" | "crane.guard" | "claude.auto-mode";
    /** Driver-reported refusal text (bounded); null when no reason was supplied. */
    reason: string | null;
  };
  /** Guard classification; non-overridable refusals always have `rules: []`. */
  guard?: { category: string; overridable: boolean };
  /** The Bash command, when the tool was Bash. */
  command?: string;
  /**
   * Suggested permission rules (e.g. `Bash(npm ci:*)`) for operator review.
   * Empty when it was refused on purpose (ALWAYS_DENIED, or a write in an
   * investigate-only task), a guard refusal has `overridable: false`, or Crane
   * has nothing safe to suggest. These are
   * heuristic suggestions, not the driver's decision reason or a guarantee
   * that granting them will resolve a refusal. An empty list explains nothing
   * about which policy refused the call.
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
