/** Agent run history and usage accounting. */

/** Why an agent ran: to work the task itself, or to resolve a merge's conflicts. */
export type RunKind = "work" | "resolve_conflicts";

export type RunOutcome = "running" | "succeeded" | "failed" | "cancelled";

/** What one agent run used, as its driver reported it. */
export interface RunUsage {
  /**
   * The driver's own figure, at API prices. On a subscription it's an estimate,
   * not a bill. The known subtotal when costStatus is unknown.
   */
  costUsd: number;
  /** Omitted by drivers that report their own cost. Unknown can include a known subtotal. */
  costStatus?: "reported" | "estimated" | "unknown";
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
