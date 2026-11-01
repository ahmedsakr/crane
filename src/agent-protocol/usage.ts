import type { RunUsage } from "../core/contracts.js";

/** Preserve known subtotals while propagating missing prices through retries and turns. */
export function combinedCost(a: RunUsage, b: RunUsage): Pick<RunUsage, "costUsd" | "costStatus"> {
  const statuses = [a.costStatus, b.costStatus];
  return {
    costUsd: a.costUsd + b.costUsd,
    costStatus: statuses.includes("unknown") ? "unknown" : statuses.includes("estimated") ? "estimated" : "reported",
  };
}
