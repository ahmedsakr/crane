import type { Task, Repo } from "../core/types.js";
import type { AgentJob, ResolveConflictsJob } from "./driver.js";

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

export function systemPrompt(task: Task, repo: Repo | null, job?: AgentJob): string {
  if (job?.kind === "resolve_conflicts") return conflictSystemPrompt(repo, job);
  return [
    "You are an agent in Crane, an autonomous software factory steered by a human operator.",
    KIND_BRIEF[task.kind],
    AUTONOMY_BRIEF[task.autonomy],
    repo ? `Target repository: ${repo.name} (default branch: ${repo.defaultBranch}).` : "",
    "Narrate briefly as you go: one short sentence before each significant step, so the operator can follow along.",
    reportInstructions(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function conflictSystemPrompt(repo: Repo | null, job: ResolveConflictsJob): string {
  const main = repo?.defaultBranch ?? "the default branch";
  return [
    "You are an agent in Crane, an autonomous software factory steered by a human operator.",
    `The operator approved a task and asked Crane to merge its branch into ${main}. Crane has started that merge in this directory, which is Crane's own isolated worktree (HEAD is detached at ${job.base}; MERGE_HEAD is the task branch). It stopped on conflicts. Your job is to resolve them.`,
    [
      "How to resolve:",
      "- Keep the intent of both sides: the task's change and whatever landed on the default branch since. Never drop one side just to make the conflict go away.",
      "- Remove every conflict marker, then `git add` each resolved file.",
      "- Use `git diff`, `git log`, and `git show` to understand what each side changed. `git log --oneline HEAD..MERGE_HEAD` is the task's work; `git log --oneline MERGE_HEAD..HEAD` is what landed on the default branch.",
      "- If the project has quick checks (a typecheck, the test suite), run them and fix anything the merge broke.",
      "- Do not commit, and do not run git merge, checkout, reset, rebase, or push. Crane checks your resolution, commits it, and pushes.",
      "- If you can't resolve a conflict with confidence, leave its markers in place and explain why in your report. Crane will hand the task back to the operator instead of merging.",
    ].join("\n"),
    "Narrate briefly as you go: one short sentence before each significant step, so the operator can follow along.",
    reportInstructions(),
  ].join("\n\n");
}

export function userPrompt(task: Task, job?: AgentJob): string {
  if (job?.kind === "resolve_conflicts") {
    const summary = task.report?.summary ? `\n\nWhat the task did: ${task.report.summary}` : "";
    return [
      `# Resolve merge conflicts: ${task.title}`,
      `Merging \`${task.branch}\` into \`${job.base}\` conflicts in:\n\n${job.files.map((f) => `- ${f}`).join("\n")}`,
      `## The original task\n\n${task.brief}${summary}`,
    ].join("\n\n");
  }
  return `# ${task.title}\n\n${task.brief}`;
}

/** What an agent is told when it picks its own session back up after the factory restarted. */
export function resumePrompt(): string {
  return [
    "Crane restarted while you were working on this task, which stopped you mid-step. Your work so far is still in this directory.",
    "Pick up where you left off. If you were in the middle of a command or an edit, check that it finished (`git status`, `git diff`, re-run the command) before moving on.",
    `When you are finished, end your final message with the \`${REPORT_FENCE}\` block, as before.`,
  ].join("\n\n");
}

function reportInstructions(): string {
  return [
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
  ].join("\n\n");
}
