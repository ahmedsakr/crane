import type { RunUsage } from "./types.js";

/** Cost only: callers decide whether a running attempt should show a status instead. */
export function runCostLabel(run: Pick<RunUsage, "costUsd" | "costStatus">, formatUsd: (cost: number) => string): string {
  if (run.costStatus === "unknown") {
    return run.costUsd ? `${formatUsd(run.costUsd)} + unknown` : "Unknown";
  }
  return `${run.costStatus === "estimated" ? "~" : ""}${formatUsd(run.costUsd)}`;
}

export function runTokens(run: Pick<RunUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  return run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens + run.outputTokens;
}
