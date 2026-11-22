import type { DriverName, Repo, RunnerJob, RunnerJobKind } from "@crane/contracts";
import type { RunContext } from "@crane/agent-protocol";
import { git } from "@crane/backend-runtime";
import { comparisonBase, finalizeWorktree } from "../git.js";
import { revParse } from "../merge-git.js";

/** What a job row stores: the brief a container claims, before it has an id or a lease. */
export type JobPayload = Omit<RunnerJob, "id" | "leaseExpiresAt">;

/** What a run asks a container for: its merge job, an investigation, or the task's own work. */
export function jobKind(ctx: Pick<RunContext, "job" | "task">): RunnerJobKind {
  return ctx.job?.kind ?? (ctx.task.autonomy === "observe" ? "observe" : "work");
}

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");

async function need(cwd: string, ref: string, what: string): Promise<string> {
  const sha = await revParse(cwd, ref);
  if (!sha) throw new Error(`Couldn't find ${what} to send to the container`);
  return sha;
}

/**
 * Where a work job starts: the commit the branch left the default branch at,
 * and the branch's own commits on top. Leftover uncommitted work (a local run
 * stopped before Crane committed it) is committed first, so the container gets it
 * and the worktree is clean for the fast-forward that brings its work back.
 */
async function workCommits(ctx: RunContext, repo: Repo): Promise<{ base: string; tip: string | null }> {
  if (await git(ctx.cwd, "status", "--porcelain")) await finalizeWorktree(repo, ctx.task, ctx.cwd);
  const tip = await head(ctx.cwd);
  const against = await comparisonBase(repo);
  const base = against ? await git(ctx.cwd, "merge-base", against, "HEAD").catch(() => tip) : tip;
  return { base, tip: base === tip ? null : tip };
}

/** The commits each kind of job is built from, read from Crane's own directory for the run. */
async function jobCommits(ctx: RunContext, kind: RunnerJobKind, repo: Repo): Promise<{ base: string; tip: string | null }> {
  const job = ctx.job;
  if (kind === "work") return workCommits(ctx, repo);
  if (job?.kind === "fix_checks") return { base: await need(ctx.cwd, job.commit, "the merge commit"), tip: null };
  if (job?.kind === "resolve_conflicts" && job.phase === "validate") {
    // The checkpoint is the merge commit: default first, task branch second.
    const checkpoint = job.checkpoint ?? await head(ctx.cwd);
    return { base: await need(ctx.cwd, `${checkpoint}^1`, "the default branch"), tip: await need(ctx.cwd, `${checkpoint}^2`, "the task branch") };
  }
  if (job?.kind === "resolve_conflicts") {
    // The merge stopped on conflicts: HEAD is the default commit, MERGE_HEAD the task branch.
    const tip = await revParse(ctx.cwd, "MERGE_HEAD") ?? await need(ctx.cwd, `refs/heads/${ctx.task.branch}`, "the task branch");
    return { base: await head(ctx.cwd), tip };
  }
  return { base: await head(ctx.cwd), tip: null };
}

/**
 * The brief a container works from. It names commits, never paths: the
 * container fetches them as a bundle and works in its own directories.
 */
export async function jobPayload(ctx: RunContext, driver: DriverName): Promise<JobPayload> {
  const repo = ctx.repo;
  if (!repo) throw new Error("This task has no repo to send to a container");
  const kind = jobKind(ctx);
  const { base, tip } = await jobCommits(ctx, kind, repo);
  const optional = {
    model: ctx.model, effort: ctx.effort, maxTurns: ctx.maxTurns, resumeSession: ctx.resumeSession, job: ctx.job,
    checks: ctx.checks, siblingTasks: ctx.siblingTasks ? [...ctx.siblingTasks] : undefined,
    prerequisites: ctx.prerequisites ? [...ctx.prerequisites] : undefined, postmortemPrompt: ctx.postmortemPrompt,
    commandEvidence: ctx.commandEvidence ? [...ctx.commandEvidence] : undefined,
    priorRefusals: ctx.priorRefusals ? [...ctx.priorRefusals] : undefined,
    allowedTools: ctx.allowedTools, commandAccess: ctx.commandAccess, dependencyProblem: ctx.dependencyProblem,
  };
  return {
    kind,
    taskId: ctx.task.id,
    title: ctx.task.title,
    autonomy: ctx.task.autonomy,
    repo: { id: repo.id, name: repo.name, defaultBranch: repo.defaultBranch },
    task: { ...ctx.task, worktree: null },
    base,
    branch: kind === "observe" ? null : ctx.task.branch,
    tip,
    driver,
    // Unset fields stay out of the stored JSON.
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}
