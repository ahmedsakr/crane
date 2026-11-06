import { join } from "node:path";
import { errorMessage, type Repo, type Report, type Task, type ValidationRun } from "@crane/contracts";
import { worktreesDir } from "../core/paths.js";
import { retainScreenshots } from "../core/screenshots.js";
import { runAgent } from "./agent-runner.js";
import type { DashboardBuilder } from "./dashboard.js";
import { driverFor } from "./driver-selection.js";
import { removeWorktree } from "./git.js";
import { deleteMergedBranch, landTask, MergeError, type MergeRequest, type MergeResult } from "./merge.js";
import { minutes } from "./run-limits.js";
import { hasVisualDecision, requireCandidateVisualReview, visualReviewRequired } from "./visual-review.js";
import type { CrewMember, WorkRunDeps } from "./work-run.js";

/** What landing a task needs from the factory that started it. */
export type MergeRunDeps = Pick<WorkRunDeps, "store" | "drivers" | "agentRunner" | "timeLimitMin" | "log"> & {
  /** Builds the dashboard from a merge into Crane's own repo, when this factory does that. */
  dashboard: DashboardBuilder | null;
};

/** One agent landing one approved task. */
export interface MergeRun {
  agent: CrewMember;
  task: Task;
  repo: Repo | null;
  signal: AbortSignal;
  emit: MergeRequest["emit"];
}

/** Land an approved task on its repo's default branch, with an agent on hand for conflicts. A failure is for `handleMergeFailure`. */
export async function runMerge(deps: MergeRunDeps, run: MergeRun) {
  const { store, log, dashboard } = deps;
  const { task, repo } = run;
  if (!repo) throw new MergeError("This task has no repo to merge into");
  if (!task.branch) throw new MergeError("This task has no branch to merge");
  const workdir = task.worktree ?? join(worktreesDir(), task.id);
  store.updateTask(task.id, { worktree: workdir });

  const result = await landTask(mergeRequest(deps, run, repo, workdir));

  // Record the outcome before cleaning up: if the merge just updated Crane's own
  // checkout, a dev server may restart any moment.
  recordMerged(deps, run, repo, result);
  await removeWorktree(repo, workdir);
  if (!result.checkoutBehind) await deleteMergedBranch(repo, task.branch);
  // A change to Crane itself: build the dashboard from it, so it shows without anyone running npm run build.
  if (repo.isFactory) dashboard?.request(result.head, task.id).catch((err) => log(`Couldn't start the dashboard build: ${errorMessage(err)}`));
}

function mergeRequest(deps: MergeRunDeps, run: MergeRun, repo: Repo, workdir: string): MergeRequest {
  const { store } = deps;
  const { task, signal, emit } = run;
  const resolver = conflictResolver(deps, run, repo);
  return {
    repo,
    task,
    workdir,
    emit,
    signal,
    checks: store.repoChecks(repo.id),
    reviewedCandidate: hasVisualDecision(task.visualReview) ? task.visualReview.commit : undefined,
    verifyVisualReview: async (commit, tree, branchCommit, changedFiles) => requireCandidateVisualReview(store, task.id, {
      commit, tree, branchCommit, changedFiles, conflictChangedUi: resolver.changedUi(),
    }),
    recordValidation: (validation) => recordMergeCheck(deps, run, validation),
    resolveConflicts: resolver.run,
    validateResolution: resolver.run,
  };
}

/** What either phase of conflict resolution hands the resolver: `checkpoint` is set only when validating. */
interface ResolverContext {
  cwd: string;
  base: string;
  files: string[];
  deferredDependencies?: string[];
  checkpoint?: string;
  visualReviewRequired?: boolean;
}

/** The agent that resolves this merge's conflicts, remembering whether any of its runs changed UI. */
function conflictResolver(deps: MergeRunDeps, run: MergeRun, repo: Repo) {
  let changedUi = false;
  const resolve = async (ctx: ResolverContext) => {
    changedUi ||= ctx.visualReviewRequired ?? false;
    const report = await runResolverAgent(deps, run, repo, ctx);
    changedUi ||= visualReviewRequired({ ...report, changedFiles: [...report.changedFiles, ...ctx.files] });
    keepResolverScreenshots(deps, run, ctx.cwd, report);
    for (const f of report.findings) run.emit("finding", f.title, { impact: f.impact, effort: f.effort });
    return { visualReviewRequired: changedUi };
  };
  return { run: resolve, changedUi: () => changedUi };
}

async function runResolverAgent({ store, drivers, agentRunner }: MergeRunDeps, { agent, task, signal, emit }: MergeRun, repo: Repo, ctx: ResolverContext): Promise<Report> {
  const { cwd, base, files, deferredDependencies, checkpoint } = ctx;
  const current = store.getTask(task.id)!;
  const { report } = await runAgent(agentRunner, agent.id, driverFor(store, drivers, current, agent.id), {
    task: current, repo, cwd, signal, emit,
    job: { kind: "resolve_conflicts", phase: checkpoint ? "validate" : "edit", base, files,
      ...(checkpoint ? { checkpoint } : {}), ...(deferredDependencies ? { deferredDependencies } : {}) },
    checks: store.repoChecks(repo.id),
  });
  return report;
}

function keepResolverScreenshots({ store }: MergeRunDeps, { task, emit }: MergeRun, cwd: string, resolverReport: Report) {
  if (!resolverReport.screenshots?.length) return;
  const screenshots = retainScreenshots(task.id, cwd, resolverReport.screenshots, message => emit("note", message));
  const report = store.getTask(task.id)?.report;
  if (report && screenshots.length) store.updateTask(task.id, { report: { ...report, screenshots } });
}

function recordMergeCheck({ store }: MergeRunDeps, { task, emit }: MergeRun, validation: ValidationRun) {
  const report = store.getTask(task.id)?.report ?? { summary: "", findings: [], changedFiles: [] };
  store.updateTask(task.id, { report: { ...report, validation: [...(report.validation ?? []), validation] } });
  emit("note", `Merge check ${validation.status}: ${validation.command ?? "configuration"}`, { validation });
}

function recordMerged({ store, log }: MergeRunDeps, { agent, task }: MergeRun, repo: Repo, result: MergeResult) {
  const main = repo.defaultBranch;
  const where = result.pushedTo ? ` and pushed to ${result.pushedTo}` : "";
  const message = result.checkoutBehind
    ? `Merged into ${main}${where}. Your checkout at ${result.checkoutBehind} has local changes, so it wasn't updated`
    : `Merged into ${main}${where}`;
  store.completeMerge(task.id, message, {
    merge: { commit: result.commit, head: result.head, pushedTo: result.pushedTo, checkoutBehind: result.checkoutBehind },
  });
  log(`${agent.name} merged ${task.id}`);
}

/** The state of the merge's controller when it failed. */
export interface MergeRunSignals {
  timeLimitHit: boolean;
  aborted: boolean;
}

/** File a merge that threw: back with the operator, unless the factory is stopping and the next one should retry it. */
export function handleMergeFailure(deps: MergeRunDeps, { agent, task, emit }: MergeRun, error: unknown, signals: MergeRunSignals) {
  const { store, log } = deps;
  if (signals.aborted && !signals.timeLimitHit) {
    // The factory is stopping. Leave it waiting; the next factory picks it up again.
    store.updateTask(task.id, { agentId: null });
    return;
  }
  const message = signals.timeLimitHit
    ? `Merging took longer than ${minutes(deps.timeLimitMin)}, the most a task may run`
    : errorMessage(error);
  emit("error", message, signals.timeLimitHit ? { limit: "time" } : undefined);
  store.setStatus(task.id, "needs_review", "Couldn't merge. Back with you", { merge: { error: message } });
  log(`${agent.name} couldn't merge ${task.id}: ${message}`);
}
