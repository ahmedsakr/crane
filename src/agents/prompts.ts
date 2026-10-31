import type { Task, Repo } from "../core/types.js";

export const REPORT_FENCE = "crane-report";

const KIND_BRIEF: Record<Task["kind"], string> = {
  maintenance:
    "This is a maintenance task. Keep the codebase healthy: find the real cause, prefer the smallest correct fix, and call out risk.",
  repo_feature:
    "This is a feature research task for the target repository. Understand how the codebase is shaped today, then work out how the feature should fit into it.",
  factory_feature:
    "This is a factory feature task. The target repository is Crane itself, the software factory you are running inside. Improve the factory with the same care you would give any production codebase.",
};

const AUTONOMY_BRIEF: Record<Task["autonomy"], string> = {
  observe:
    "You are in investigate-only mode. Do not modify, create, or delete files. Read, search, and run read-only commands only. Your output is the report.",
  propose:
    "You may change files. You are working in an isolated git worktree on your own branch, so edits cannot affect the operator's checkout. Commit your work with clear messages. The operator will review the branch before anything is merged.",
  act: "You may change files. You are working in an isolated git worktree on your own branch. Commit your work with clear messages. Never push, and never touch the default branch.",
};

export function systemPrompt(task: Task, repo: Repo | null): string {
  return [
    "You are an agent in Crane, an autonomous software factory steered by a human operator.",
    KIND_BRIEF[task.kind],
    AUTONOMY_BRIEF[task.autonomy],
    repo ? `Target repository: ${repo.name} (default branch: ${repo.defaultBranch}).` : "",
    "Narrate briefly as you go: one short sentence before each significant step, so the operator can follow along.",
    `When you are finished, end your final message with a fenced code block tagged \`${REPORT_FENCE}\` containing JSON with this shape:`,
    "```" + REPORT_FENCE,
    JSON.stringify(
      {
        summary: "Two or three sentences the operator can read in ten seconds.",
        findings: [
          {
            title: "Short, specific title",
            detail: "What you found, why it matters, and what you recommend. Markdown is fine.",
            impact: "low | medium | high",
            effort: "small | medium | large",
          },
        ],
        changedFiles: ["path/relative/to/repo"],
      },
      null,
      2,
    ),
    "```",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function userPrompt(task: Task): string {
  return `# ${task.title}\n\n${task.brief}`;
}
