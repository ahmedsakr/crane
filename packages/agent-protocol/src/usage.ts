import type { RunUsage } from "@crane/contracts";

/** Preserve known subtotals while propagating missing prices through retries and turns. */
export function combinedCost(a: RunUsage, b: RunUsage): Pick<RunUsage, "costUsd" | "costStatus"> {
  const statuses = [a.costStatus, b.costStatus];
  return {
    costUsd: a.costUsd + b.costUsd,
    costStatus: combinedCostStatus(statuses),
  };
}

function combinedCostStatus(statuses: RunUsage["costStatus"][]): RunUsage["costStatus"] {
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("estimated")) return "estimated";
  return "reported";
}

/** Add incremental reports, retaining the latest known model. The first report stays intact. */
export function addRunUsage(prev: RunUsage | null, next: RunUsage): RunUsage {
  if (!prev) return next;
  return {
    ...combinedCost(prev, next),
    inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: prev.cacheWriteTokens + next.cacheWriteTokens,
    turns: prev.turns + next.turns,
    model: next.model ?? prev.model,
  };
}
