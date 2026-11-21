import type { Goal, GoalPlan, Report } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";

export const plan = (): GoalPlan => ({ summary: "Deliver reliable saved carts", approach: "Extract cart storage first; then UI and API can run together. Integrate after both land.",
  improvements: ["Later, unify the cart and checkout telemetry"], tasks: [
    { key: "storage", title: "Extract cart storage", brief: "Extract storage and retain existing behavior", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "Careful contract refactoring before callers change", acceptance: ["Existing storage callers keep working"] },
    { key: "ui", title: "Build saved cart UI", brief: "Use the storage contract for saved carts", dependsOn: ["storage"], driver: "claude-code", model: "sonnet", effort: "high", rationale: "UI work after the shared contract lands", acceptance: ["Saved carts can be reopened"] },
    { key: "api", title: "Add saved cart API", brief: "Use the storage contract in the API", dependsOn: ["storage"], driver: "codex", model: null, effort: "medium", rationale: "Independent API work after the contract", acceptance: ["API can save and restore a cart"] },
    { key: "integration", title: "Verify saved carts", brief: "Exercise both paths and fix integration gaps", dependsOn: ["ui", "api"], driver: "claude-code", model: "opus", effort: "high", rationale: "Cross-cutting verification after both branches merge", acceptance: ["A cart saved through the UI survives reload"] },
  ] });

export function setupGoal(file = ":memory:") {
  const store = new Store(file);
  const repo = store.addRepo({ path: "/goals-repo", name: "storefront" });
  const actions = new OperatorActions(store);
  const goal = actions.createGoal({ repoId: repo.id, outcome: "Customers can save and reopen carts", driver: "codex", effort: "high" });
  return { store, repo, actions, goal };
}

export function researchResult(store: Store, goal: Goal, change: Partial<Report> = {}) {
  store.updateTask(goal.researchTaskId, { status: "needs_review", report: { summary: "Planning complete", findings: [], changedFiles: [],
    completion: { status: "completed", reason: "Research complete", evidence: "Read storage, API and UI" }, goalPlan: plan(), ...change } });
  store.syncGoals();
  return store.getGoal(goal.id)!;
}
