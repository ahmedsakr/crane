import { DRIVER_NAMES, EFFORT_LEVELS, type Goal, type NewTask, type Repo, type TaskRunOptions } from "@crane/contracts";
import type { Store } from "../core/store.js";
import { driverSettings } from "./drivers.js";

/** Planning uses the same read-only driver guards, limits, cost ledger and recovery as any research task. */
export function goalResearchTask(store: Store, repo: Repo, outcome: string, research: TaskRunOptions,
  previous?: Pick<Goal, "plan" | "feedback">, feedback?: string): NewTask {
  const catalog = DRIVER_NAMES.map((driver) => ({ driver, ...driverSettings((key) => store.getSetting(key), driver), efforts: EFFORT_LEVELS[driver] }));
  return { kind: repo.isFactory ? "factory_feature" : "repo_feature", title: `Plan: ${outcome.slice(0, 100)}`,
    repoId: repo.id, autonomy: "observe", ...research,
    brief: [
      "Crane goal research",
      `Desired outcome:\n${outcome}`,
      "Research the repository and its agent instructions. Discover all work needed to achieve the outcome, including supporting code improvements, refactoring, tests and integration. Cite concrete files and existing behavior in the approach. Do not change files or start implementation tasks.",
      "Produce a complete, reviewable task dependency graph. Independent tasks may run on separate crew slots; a dependency waits until its predecessor is MERGED into the default branch. Serialize tasks that edit overlapping areas or depend on the same evolving contract. Include a final integration/acceptance task that depends on all delivery work. Avoid dependencies on work missing from this checkout; describe unmet prerequisites explicitly.",
      "Assign each task to claude-code or codex and choose model/effort appropriate to its difficulty, with a rationale. Use the configured model or null for its default rather than inventing model names. Use simulated only for a simulation requested by the operator. Each task needs a self-contained brief and observable acceptance criteria. Include necessary refactoring as actual tasks, and optional suggestions separately in improvements.",
      `Configured agents and supported efforts (availability is checked at execution):\n${JSON.stringify(catalog)}`,
      `Repository checks Crane runs itself on each finished task:\n${JSON.stringify(store.repoChecks(repo.id))}\nWhen a task requires one to pass, put its exact command in that task's optional "acceptanceChecks" list, not in an acceptance criterion: agents may be unable to run these, and only Crane's own passing result meets them. Name only commands from this list. Don't combine a check with anything else in one criterion. Acceptance criteria are for what the work itself must do.`,
      previous?.plan ? `Previous draft (replace it with a full revised plan):\n${JSON.stringify(previous.plan)}` : "",
      previous?.feedback.length ? `Earlier operator feedback:\n${previous.feedback.map((f) => f.text).join("\n\n")}` : "",
      feedback ? `New operator feedback:\n${feedback}` : "",
      'In your final crane-report JSON, include "completion" with status "completed" only when the planning is complete, plus an EXTRA field "goalPlan" with this exact shape:',
      JSON.stringify({ summary: "How the tasks deliver the desired outcome", approach: "Repository evidence, ordering, parallelism, risks and integration strategy", improvements: ["Optional improvement and its benefit"], tasks: [
        { key: "foundation", title: "First task", brief: "Self-contained implementation instructions", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "Why this agent, effort, and ordering fit the task", acceptance: ["Observable result"] },
        { key: "integration", title: "Verify the outcome", brief: "Integrate and verify delivery; fix gaps", dependsOn: ["foundation"], driver: "claude-code", model: null, effort: "high", rationale: "Review the completed outcome after delivery", acceptance: ["The desired outcome works end to end"] },
      ] }),
      "Use 1–40 tasks, unique lowercase keys, no cycles, and at most 20 dependencies and acceptance criteria per task. The operator reviews the entire plan before any implementation runs. If research is blocked or scope is unresolved, report that completion outcome honestly; do not claim a completed plan.",
    ].filter(Boolean).join("\n\n") };
}
