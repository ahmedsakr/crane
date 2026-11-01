import type { Task, Repo } from "@crane/contracts";
import { REPORT_FENCE, type AgentJob, type ResolveConflictsJob, type SiblingTask } from "../agent-protocol/index.js";

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

const BLOCKED_BRIEF =
  "Some commands are not allowed. If one is blocked, don't hunt for a workaround that does the same thing: say what you needed it for, carry on without it if you can, and mention it in your report. Do not retry the blocked operation through a script, node, Python, another shell, or a rewritten command. A refused compound command does not mean compound commands in general need approval; do not guess which part was denied or repackage it to get past the refusal. Crane shows the operator every blocked command so they can allow it for next time.";

const VALIDATION_BRIEF =
  "Report validation accurately: distinguish checks that passed from checks that failed, were blocked, or were not run. If a blocked command prevents an end-to-end check, state that the check remains incomplete in your final report; passing unit tests or a clean diff does not complete it. Include the blocked command's purpose and any remaining validation in the report even if you can finish the code changes.";

const FILE_EDIT_BRIEF =
  "When file changes are authorized, use your native file-editing tools (such as Edit, Write, or apply_patch) to create and modify files. Avoid shell heredocs for file edits: they can trigger shell security checks even when the intended edit is allowed. Choose file-editing tools before attempting a shell write; a denied command is still subject to the blocked-command instructions.";

const SCREENSHOT_BRIEF =
  "If you built or changed UI, capture screenshots of the finished UI using the repository's existing screenshot or browser tools, inspect them, and attach them in your report's screenshots array. Include the changed views and relevant desktop and phone sizes, with captions describing the view and viewport. Save PNG, JPEG, or WebP files inside the worktree (prefer an ignored directory such as .crane/screenshots), and report worktree-relative paths. Crane retains up to 12 images, each at most 10 MiB, with the task after the worktree is removed. Do not commit screenshots just to attach them. If capture is blocked or unavailable, explain the reason and the remaining visual validation in your summary; leave screenshots empty and never substitute mockups or claim capture succeeded. Screenshot instructions do not authorize writes in investigate-only mode or bypassing sandbox restrictions.";

/**
 * For agents in a sandbox with no network (Codex). On Linux, Codex enforces
 * "no network" with a seccomp filter that also refuses calls like `listen`,
 * `shutdown` and `getsockopt` on local sockets. Node gives child processes
 * socketpairs for piped stdio, so some subprocesses fail (`spawnSync git EPERM`)
 * or lose their output, and nothing can serve a page. None of that is the
 * agent's code, and the sandbox must stay as it is, so the agent is told what
 * to expect and to report those checks as blocked rather than bend the work to
 * get them passing.
 */
const SANDBOX_BRIEF =
  'Your sandbox has no network, and it also refuses some local operations that have nothing to do with your change. Expect these to fail with EPERM or "operation not permitted": listening on a port, even on localhost, so dev servers, browsers, and screenshot tools can\'t run; and some child processes started with piped stdin or stdout, such as `spawnSync` or `execFileSync` with default stdio, or a test runner that runs each file in its own process (it then shows only per-file results). When a check fails this way, don\'t change tests, scripts, or code to get around the sandbox. Run the narrowest check that does work, such as a single test file run directly, and list the blocked check in your report as not run, with its error, so the operator can run it outside the sandbox.';

/**
 * For agents whose sandbox can't write to git (Codex): the worktree's git
 * directory lives outside it. Crane commits what they leave behind instead.
 */
const SANDBOXED_AUTONOMY_BRIEF: Record<Task["autonomy"], string> = {
  ...AUTONOMY_BRIEF,
  propose:
    "You may change files. You are working in an isolated git worktree on your own branch, so edits cannot affect the operator's checkout. Leave your changes in the working tree: Crane commits them to the branch when you finish. Your sandbox can't write to git, so don't try to commit. The operator will review the branch before anything is merged.",
  act: "You may change files. You are working in an isolated git worktree on your own branch. Leave your changes in the working tree: Crane commits them to the branch when you finish. Your sandbox can't write to git, so don't try to commit, and never push.",
};

/**
 * The repo's configured checks, which Crane runs itself once the agent
 * finishes (a review check after work, a merge check after resolving
 * conflicts). Without this, an agent whose environment refuses one of them
 * reports a high-impact finding and "validation incomplete" for a check that
 * Crane runs and records anyway.
 */
function checksBrief(checks: readonly string[] | undefined, sandboxed: boolean): string {
  if (!checks?.length) return "";
  const where = sandboxed ? "outside your sandbox" : "in this directory";
  const list = checks.map((c) => `\`${c}\``).join(", ");
  return `After you finish, Crane runs these checks itself, ${where}, and records their results on the task: ${list}. Run them yourself where you can, and fix what your change breaks. If one is blocked or refused in your environment, say in your report that it's left to Crane's check, rather than raising a finding about it or calling your validation incomplete.`;
}

export interface PromptOptions {
  /** The agent can run `git commit` and `git add` itself. False for sandboxed agents. */
  agentCommits?: boolean;
  /** The agent runs in a sandbox with no network, which also refuses some local socket calls (Codex). */
  sandboxed?: boolean;
  /** Checks Crane runs after the agent finishes (`RunContext.checks`). */
  checks?: readonly string[];
}

export function systemPrompt(task: Task, repo: Repo | null, job?: AgentJob, opts: PromptOptions = {}): string {
  const commits = opts.agentCommits ?? true;
  const sandbox = opts.sandboxed ? SANDBOX_BRIEF : "";
  const checks = checksBrief(opts.checks, !!opts.sandboxed);
  if (job?.kind === "resolve_conflicts") return conflictSystemPrompt(repo, job, commits, sandbox, checks);
  return [
    "You are an agent in Crane, an autonomous software factory steered by a human operator.",
    KIND_BRIEF[task.kind],
    (commits ? AUTONOMY_BRIEF : SANDBOXED_AUTONOMY_BRIEF)[task.autonomy],
    repo ? `Target repository: ${repo.name} (default branch: ${repo.defaultBranch}).` : "",
    "Narrate briefly as you go: one short sentence before each significant step, so the operator can follow along.",
    BLOCKED_BRIEF,
    sandbox,
    VALIDATION_BRIEF,
    checks,
    FILE_EDIT_BRIEF,
    task.autonomy !== "observe" ? SCREENSHOT_BRIEF : "",
    reportInstructions(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function conflictSystemPrompt(
  repo: Repo | null,
  job: ResolveConflictsJob,
  agentCommits: boolean,
  sandbox: string,
  checks: string,
): string {
  const main = repo?.defaultBranch ?? "the default branch";
  return [
    "You are an agent in Crane, an autonomous software factory steered by a human operator.",
    `The operator approved a task and asked Crane to merge its branch into ${main}. Crane has started that merge in this directory, which is Crane's own isolated worktree (HEAD is detached at ${job.base}; MERGE_HEAD is the task branch). It stopped on conflicts. Your job is to resolve them.`,
    [
      "How to resolve:",
      "- Keep the intent of both sides: the task's change and whatever landed on the default branch since. Never drop one side just to make the conflict go away.",
      agentCommits
        ? "- Remove every conflict marker, then `git add` each resolved file."
        : "- Remove every conflict marker. Crane stages the resolved files itself; your sandbox can't write to git.",
      "- Use `git diff`, `git log`, and `git show` to understand what each side changed. `git log --oneline HEAD..MERGE_HEAD` is the task's work; `git log --oneline MERGE_HEAD..HEAD` is what landed on the default branch.",
      "- If the project has quick checks (a typecheck, the test suite), run them and fix anything the merge broke.",
      "- Do not commit, and do not run git merge, checkout, reset, rebase, or push. Crane checks your resolution, commits it, and pushes.",
      "- If you can't resolve a conflict with confidence, leave its markers in place and explain why in your report. Crane will hand the task back to the operator instead of merging.",
    ].join("\n"),
    "Narrate briefly as you go: one short sentence before each significant step, so the operator can follow along.",
    BLOCKED_BRIEF,
    sandbox,
    VALIDATION_BRIEF,
    checks,
    FILE_EDIT_BRIEF,
    SCREENSHOT_BRIEF,
    reportInstructions(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function siblingTasksBrief(tasks?: readonly SiblingTask[]): string {
  if (!tasks) return "";
  return [
    "## Other recent tasks in this repository",
    "This is a snapshot at the start of this run, not a live view. It lists up to 200 recent pending or unmerged tasks. Commits listed here are on their branches, not necessarily available in your checkout. Do not enter or inspect other tasks' worktrees. If your task requires setup from one of these tasks that is missing here, report the unmet prerequisite and unfinished scope explicitly; do not silently reduce the requested scope.",
    tasks.length ? "" : "No other pending or unmerged tasks were found.",
    ...tasks.map((t) => JSON.stringify({
      id: t.id,
      title: t.title,
      status: t.status,
      branch: t.branch,
      commitsNotOnDefaultBranch: t.hasCommits === null ? "unknown" : t.hasCommits ? "yes" : "no",
    })),
  ].filter(Boolean).join("\n\n");
}

export function userPrompt(task: Task, job?: AgentJob, siblingTasks?: readonly SiblingTask[]): string {
  if (job?.kind === "resolve_conflicts") {
    const summary = task.report?.summary ? `\n\nWhat the task did: ${task.report.summary}` : "";
    return [
      `# Resolve merge conflicts: ${task.title}`,
      `Merging \`${task.branch}\` into \`${job.base}\` conflicts in:\n\n${job.files.map((f) => `- ${f}`).join("\n")}`,
      `## The original task\n\n${task.brief}${summary}`,
    ].join("\n\n");
  }
  return [`# ${task.title}\n\n${task.brief}`, siblingTasksBrief(siblingTasks)].filter(Boolean).join("\n\n");
}

/**
 * What an agent is told when it picks its own session back up: after the
 * factory restarted, or after Crane retried it past a temporary API error.
 */
export function resumePrompt(siblingTasks?: readonly SiblingTask[]): string {
  return [
    "You were stopped mid-step while working on this task, because Crane restarted or the API had a temporary error, and Crane has resumed this session. Your work so far is still in this directory.",
    "Pick up where you left off without redoing finished work. If you were in the middle of a command or an edit, check whether it finished (`git status`, `git diff`) before moving on. Only re-run a command if it was not denied and repeating it is safe.",
    BLOCKED_BRIEF,
    VALIDATION_BRIEF,
    FILE_EDIT_BRIEF,
    SCREENSHOT_BRIEF,
    siblingTasksBrief(siblingTasks),
    `When you are finished, end your final message with the \`${REPORT_FENCE}\` block, as before.`,
  ].filter(Boolean).join("\n\n");
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
        screenshots: [{ path: ".crane/screenshots/updated-view.png", caption: "Updated view at 1280 × 800" }],
      },
      null,
      2,
    ),
    "```",
  ].join("\n\n");
}
