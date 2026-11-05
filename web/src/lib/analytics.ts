/** What the analytics page derives from its numbers. Pure: no DOM and no React. */
import type { Analytics } from "@crane/contracts";
import { plural, usd } from "./format.js";

export const RANGES = [7, 30, 90] as const;
export type Days = (typeof RANGES)[number];

const DEFAULT_RANGE: Days = 30;
const LONGEST_RANGE: Days = 90;
const ROUND_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

export const DAY_SHORT: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
export const DAY_LONG: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };

/** The range in a `days` search param; anything else means the default. */
export function parseRange(raw: string | null): Days {
  return RANGES.find((days) => String(days) === raw) ?? DEFAULT_RANGE;
}

/** The default range keeps a clean URL. */
export function rangeParams(days: Days): Record<string, string> {
  return days === DEFAULT_RANGE ? {} : { days: String(days) };
}

export function dayLabel(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return new Date(iso).toLocaleDateString([], opts);
}

/** The smallest round amount at or above `v`, so the axis tops out near the tallest day. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return (ROUND_STEPS.find((m) => m * p >= v - 1e-9) ?? 10) * p;
}

export function axisTick(n: number): string {
  return `$${+n.toFixed(2)}`;
}

/** Beside the column, level with its top, and never outside the plot. */
export function tipPosition(index: number, count: number, height: number): Record<string, string> {
  const side: Record<string, string> = index < count / 2
    ? { left: `calc(${((index + 1) / count) * 100}% + 6px)` }
    : { right: `calc(${((count - index) / count) * 100}% + 6px)` };
  return { bottom: `clamp(0px, calc(${height}% - 22px), calc(100% - 46px))`, ...side };
}

/** About six date labels, counted back from today so the latest day always has one. */
export function labelsDay(index: number, count: number): boolean {
  return (count - 1 - index) % Math.ceil(count / 6) === 0;
}

export function spendComparison(a: Pick<Analytics, "spendUsd" | "prevSpendUsd">, days: number): string {
  if (a.prevSpendUsd === 0) return `nothing in the ${days} days before`;
  const delta = a.spendUsd - a.prevSpendUsd;
  return `${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))} vs the ${days} days before`;
}

export function perShippedTask(shipped: Analytics["shipped"]): string {
  return shipped.tasks ? usd(shipped.usd / shipped.tasks) : "—";
}

export function tokensIn(tokens: Analytics["tokens"]): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

export function emptyRangeHint(days: number): string {
  return days < LONGEST_RANGE ? ". Try a longer range." : ".";
}

export function unknownCostNote(runs: number): string {
  return runs > 0 ? ` ${plural(runs, "run")} with unknown costs: totals include only known amounts, so actual costs may be higher.` : "";
}
