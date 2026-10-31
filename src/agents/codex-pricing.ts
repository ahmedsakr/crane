import type { RunUsage } from "../core/types.js";

// Standard API USD per million tokens: input, cached input, output.
// Verified 2026-10-31: https://developers.openai.com/api/docs/pricing
// Estimates exclude tools, service-tier and long-context surcharges. Exact model
// names only: an unknown alias or CLI default must never inherit a guessed rate.
const PRICES = new Map<string, readonly [number, number, number]>([
  ["gpt-5.3-codex", [1.75, 0.175, 14]],
  ["gpt-6-astra", [10, 1, 50]],
  ["gpt-6.1-sol", [2, 0.1, 10]],
  ["gpt-6.1-terra", [1, 0.05, 5]],
  ["gpt-6-luna", [0.1, 0.01, 0.5]],
]);

export function codexCost(model: string | null, input: number, cached: number, output: number): number | null {
  const price = model ? PRICES.get(model) : undefined;
  return price ? (input * price[0] + cached * price[1] + output * price[2]) / 1_000_000 : null;
}

/** Preserve known subtotals while propagating missing prices through retries and turns. */
export function combinedCost(a: RunUsage, b: RunUsage): Pick<RunUsage, "costUsd" | "costStatus"> {
  const statuses = [a.costStatus, b.costStatus];
  return {
    costUsd: a.costUsd + b.costUsd,
    costStatus: statuses.includes("unknown") ? "unknown" : statuses.includes("estimated") ? "estimated" : "reported",
  };
}
