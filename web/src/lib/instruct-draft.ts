import type { Autonomy, Repo, TaskDraft } from "@crane/contracts";

/** What the operator changed on the factory's reading of their instruction. */
export type DraftOverrides = Partial<Pick<TaskDraft, "kind" | "repoId" | "autonomy">>;

const YOU_CHOSE = "You chose this";

/**
 * The task as it would start: the operator's choices over the factory's guesses,
 * each one saying where it came from. Work on the factory's own repo is always a
 * factory feature, whatever was guessed or chosen.
 */
export function mergeDraft(
  draft: TaskDraft | null,
  overrides: DraftOverrides,
  repos: readonly Pick<Repo, "id" | "isFactory">[],
): TaskDraft | null {
  if (!draft) return null;
  const merged: TaskDraft = {
    ...draft,
    ...overrides,
    why: {
      kind: overrides.kind ? YOU_CHOSE : draft.why.kind,
      repo: overrides.repoId !== undefined ? YOU_CHOSE : draft.why.repo,
      autonomy: overrides.autonomy ? YOU_CHOSE : draft.why.autonomy,
    },
  };
  const onFactory = repos.some((r) => r.id === merged.repoId && r.isFactory);
  return onFactory ? { ...merged, kind: "factory_feature" } : merged;
}

/** Investigate-only work never merges, so there's nothing to pre-approve. */
export function canPreApprove(autonomy: Autonomy): boolean {
  return autonomy !== "observe";
}

/** Example instructions, about one of the operator's own repos where there is one. */
export function instructExamples(repos: readonly Pick<Repo, "name" | "isFactory">[]): string[] {
  const target = repos.find((r) => !r.isFactory)?.name ?? "my-app";
  return [
    `Investigate why the tests are flaky in ${target}`,
    `Find dependencies in ${target} with security advisories`,
    `Research how to add audit logging to ${target}`,
    "Research what Crane should build next to need me less",
  ];
}
