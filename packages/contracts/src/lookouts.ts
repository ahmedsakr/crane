/** Optional opportunities to watch for while working a task. */

/** Opportunities an agent can be asked to look out for alongside its task. */
export const LOOKOUTS = ["refactoring", "improvements", "test_gaps"] as const;

export type Lookout = (typeof LOOKOUTS)[number];

export const isLookout = (name: unknown): name is Lookout =>
  typeof name === "string" && (LOOKOUTS as readonly string[]).includes(name);

export interface LookoutInfo {
  /** What the operator turns on: "Test gaps". */
  label: string;
  /** One line on what the agent looks for. */
  hint: string;
  /** What the agent is asked to look out for, as one item of a list. */
  brief: string;
}

export const LOOKOUT: Record<Lookout, LookoutInfo> = {
  refactoring: {
    label: "Refactoring",
    hint: "Duplicated, tangled, or unclear code near the change.",
    brief: "Refactoring: duplicated logic, functions doing too much, unclear names, dead code, and needless complexity in and around the code you work in.",
  },
  improvements: {
    label: "Improvements",
    hint: "Latent bugs, error handling, performance, rough edges.",
    brief: "Improvements: latent bugs, missing or weak error handling, performance problems, and rough edges in and around the code you work in.",
  },
  test_gaps: {
    label: "Test gaps",
    hint: "Behaviour with no tests, and tests that check too little.",
    brief: "Test coverage gaps: important behaviour with no tests, tests that assert too little, and flaky tests, starting with the code your task touches.",
  },
};

/** "Refactoring, test gaps", or null when the task asks for none. */
export function lookoutsLabel(lookouts: readonly Lookout[] | undefined): string | null {
  if (!lookouts?.length) return null;
  return lookouts.map((l, i) => (i ? LOOKOUT[l].label.toLowerCase() : LOOKOUT[l].label)).join(", ");
}
