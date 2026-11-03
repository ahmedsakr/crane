/** Merge outcome evidence and its history helper. */
import type { TaskEvent } from "./events.js";

/**
 * What the last merge attempt left behind, carried on its status event so the
 * UI and CLI can explain it. A failed attempt sends the task back to the
 * operator with `error` set.
 */
export interface MergeOutcome {
  error?: string;
  /** The merge commit that landed on the default branch, or null when the branch was already there. */
  commit?: string | null;
  /** Where the default branch pointed afterwards, so the landing can be checked even without a merge commit. */
  head?: string;
  /** The remote it was pushed to, or null when the repo has none. */
  pushedTo?: string | null;
  /** A checkout of the default branch Crane left alone (it had local changes), so the operator can catch up. */
  checkoutBehind?: string | null;
}

/** The merge outcome on the task's latest status event, if that status came from a merge. */
export function lastMergeOutcome(events: TaskEvent[]): MergeOutcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "status") return (e.data?.merge as MergeOutcome | undefined) ?? null;
  }
  return null;
}
