/** What the home page and task list derive from the overview. Pure: no DOM and no React. */
import type { Agent, GoalSummary, Overview } from "@crane/contracts";

export function repoNamer(repos: { id: string; name: string }[] = []) {
  return (id: string | null): string | undefined => repos.find((repo) => repo.id === id)?.name;
}

export function hasTargetRepo(o: Pick<Overview, "repos">): boolean {
  return o.repos.some((repo) => !repo.isFactory);
}

/** True when no work exists yet: nothing to review, running or recently finished. */
export function isSiteEmpty(o: Pick<Overview, "needsReview" | "inFlight" | "recent" | "goalsNeedingReview">): boolean {
  return !o.needsReview.length && !o.inFlight.length && !o.recent.length && !o.goalsNeedingReview?.length;
}

export function needsYouCount(o: Pick<Overview, "needsReview" | "goalsNeedingReview">): number {
  return o.needsReview.length + (o.goalsNeedingReview?.length ?? 0);
}

export function goalReviewLabel(goal: Pick<GoalSummary, "status">): string {
  return goal.status === "blocked" ? "Needs attention" : "Plan ready for review";
}

export function agentsOnShift<T extends Pick<Agent, "active" | "state">>(agents: T[]): T[] {
  return agents.filter((agent) => agent.active || agent.state === "working");
}
