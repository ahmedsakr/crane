import { completionReviewReason, driverLabel, errorMessage, isDriverName, unmetAcceptance, type EventType, type Repo, type Report, type ReviewCheckpoint, type Task, type TaskStatus } from "@crane/contracts";
import { AgentRunError } from "@crane/agent-protocol";
import { installDependencies } from "@crane/worktree-deps";
import type { Store } from "../core/store.js";
import { retainScreenshots } from "../core/screenshots.js";
import { runAgent, type AgentRunnerDeps } from "./agent-runner.js";
import { runChecks } from "./checks.js";
import { driverFor, type DriverRegistry } from "./driver-selection.js";
import { elapsed } from "./elapsed.js";
import { createWorktree, finalizeWorktree, PreparationHold, requireCommits } from "./git.js";
import { candidateUnchanged, changedInputs, reviewInputs } from "./review-checkpoint.js";
import { minutes } from "./run-limits.js";
import { candidateVisualReview } from "./visual-review.js";

export type CrewMember = { id: string; name: string };

/** What a work run needs from the factory that started it. */
export interface WorkRunDeps {
  store: Store;
  drivers: DriverRegistry;
  agentRunner: AgentRunnerDeps;
  /** Most minutes a task may hold a crew slot, for the message when a run hits it. */
  timeLimitMin: number;
  log: (line: string) => void;
  /** Make a write from a driver callback, where a failed write costs that update and nothing else. */
  recording: (write: () => void) => void;
  /** Put a running task back in the queue because the factory is stopping. */
  requeueStopped: (taskId: string) => void;
  /** A task stopped, so its worktree may be ready to put away. */
  taskEnded: (status: TaskStatus | undefined) => void;
}

/** One agent working one task. */
export interface WorkRun {
  agent: CrewMember;
  task: Task;
  signal: AbortSignal;
  emit: (type: EventType, message: string, data?: Record<string, unknown>) => void;
}

/** Where a run works. `branch` is null for investigate-only runs, which read the operator's checkout. */
interface Workspace {
  repo: Repo;
  cwd: string;
  branch: string | null;
}

/** What review checks and the outcome are judged on. */
interface Candidate {
  report: Report;
  /** Null only for investigate-only runs, which have no candidate to check. */
  checkpoint: ReviewCheckpoint | null;
  /** Whether this came from an earlier run's checkpoint, without running the agent. */
  resumed: boolean;
}

/** Take a claimed task from its workspace through to its outcome. A failure is for `handleWorkFailure`. */
export async function runWork(deps: WorkRunDeps, run: WorkRun) {
  const workspace = await prepareWorkspace(deps, run);
  const resumed = await resumeCheckpoint(deps, run, workspace);
  const candidate = resumed ?? await finalizeCandidate(deps, run, workspace, await runWorkAgent(deps, run, workspace));
  await runReviewChecks(deps, run, workspace, candidate);
  recordFindings(deps, run, candidate.report);
  fileOutcome(deps, run, candidate.report);
}

/** Hold if a prerequisite's commit is missing, and otherwise get the task's worktree and dependencies ready. */
async function prepareWorkspace(deps: WorkRunDeps, run: WorkRun): Promise<Workspace> {
  const { store } = deps;
  const { task, emit } = run;
  const repo = task.repoId ? store.getRepo(task.repoId) : null;
  if (!repo) throw new Error("This task has no repo to work in");

  const { commits: required, unrecorded } = store.prerequisiteCommits(task);
  if (unrecorded.length) emit("note", `Couldn't check that ${unrecorded.join(", ")} landed here: Crane has no record of the commit`);

  if (task.autonomy === "observe") {
    // Investigate-only runs read the operator's checkout, so that's what must contain them.
    await requireCommits(repo.path, "HEAD", required, `Your checkout at ${repo.path}`, "Crane didn't start the agent, and doesn't update your checkout. Update it, then retry this task.");
    return { repo, cwd: repo.path, branch: null };
  }
  // Reuses the worktree if an earlier run left one, so nothing done so far is lost.
  const wt = await createWorktree(repo, task, { required, signal: run.signal, note: (message) => emit("note", message) });
  store.updateTask(task.id, { branch: wt.branch, worktree: wt.path });
  emit("note", `${task.worktree ? "Back on" : "Working on"} branch ${wt.branch}`, { branch: wt.branch, ...(wt.base ? { base: wt.base } : {}) });
  await installWorktreeDependencies(run, wt.path, repo.path);
  return { repo, cwd: wt.path, branch: wt.branch };
}

async function installWorktreeDependencies({ signal, emit }: WorkRun, worktree: string, from: string) {
  const started = Date.now();
  try {
    const note = await installDependencies(worktree, {
      from,
      signal,
      onProgress: (progress) => emit("note", progress),
    });
    if (note) emit("note", note);
  } catch (err) {
    if (signal.aborted) throw err;
    // Not fatal: the agent can still read code and may be able to install itself.
    const after = elapsed(Date.now() - started);
    emit("note", `Couldn't install dependencies after ${after}: ${errorMessage(err).split("\n")[0]}`);
  }
}

/** The earlier run's candidate if it's unchanged, so it goes to review checks without the agent. A changed one loses its checkpoint. */
async function resumeCheckpoint({ store }: WorkRunDeps, { task, emit }: WorkRun, { cwd, branch }: Workspace): Promise<Candidate | null> {
  const checkpoint = task.reviewCheckpoint;
  if (!checkpoint || branch === null) return null;
  if (task.report && await candidateUnchanged(cwd, branch, checkpoint)) {
    return { report: task.report, checkpoint, resumed: true };
  }
  // The agent is about to change what this described, so it must not survive another restart.
  store.updateTask(task.id, { reviewCheckpoint: null });
  emit("note", "The candidate changed after its work finished, so its agent is picking it back up");
  return null;
}

async function runWorkAgent(deps: WorkRunDeps, { agent, task, signal, emit }: WorkRun, { repo, cwd }: Workspace): Promise<Report> {
  const { store, drivers, agentRunner, recording } = deps;
  const driver = driverFor(store, drivers, task, agent.id);
  // A session belongs to the agent that started it. Older runs didn't record theirs, so trust those.
  const owner = store.lastWorkDriver(task.id);
  const resumable = !!task.sessionId && (!isDriverName(owner) || owner === driver.name);
  if (task.sessionId && !resumable) {
    emit("note", `Switching to ${driverLabel(driver.name)}, which starts a new session on the work so far`);
  }
  const result = await runAgent(agentRunner, agent.id, driver, {
    task: store.getTask(task.id)!,
    repo,
    cwd,
    signal,
    emit,
    resumeSession: resumable ? task.sessionId! : undefined,
    onSession: (sessionId) => recording(() => store.updateTask(task.id, { sessionId })),
    // Run below as review checks. Investigate-only runs get none.
    checks: task.autonomy !== "observe" ? store.repoChecks(repo.id) : undefined,
  });
  return result.report;
}

/** Keep the run's attachments and commit its work, then record the report and the candidate it describes. */
async function finalizeCandidate({ store }: WorkRunDeps, { task, emit }: WorkRun, { repo, cwd }: Workspace, report: Report): Promise<Candidate> {
  const observe = task.autonomy === "observe";
  if (!observe) {
    report.validation = store.getTask(task.id)?.report?.validation ?? [];
  }
  if (report.screenshots) {
    // Observe runs cannot create attachments in the operator's checkout.
    report.screenshots = observe ? []
      : retainScreenshots(task.id, cwd, report.screenshots, message => emit("note", message));
    store.updateTask(task.id, { report });
  }
  if (observe) return { report, checkpoint: null, resumed: false };

  const changed = await finalizeWorktree(repo, task, cwd);
  report.hasContribution = changed.length > 0;
  report.changedFiles = [...new Set([...changed, ...report.changedFiles])];
  // One write, so a restart finds the report and the candidate it describes together, or neither.
  const checkpoint: ReviewCheckpoint = { ...await reviewInputs(cwd, store.repoChecks(repo.id)), passed: [] };
  store.updateTask(task.id, { visualReview: await candidateVisualReview(cwd, report), report, reviewCheckpoint: checkpoint });
  return { report, checkpoint, resumed: false };
}

/** Run the repo's checks on the candidate, reusing earlier passes only when nothing they depend on changed. */
async function runReviewChecks({ store }: WorkRunDeps, { task, signal, emit }: WorkRun, { repo, cwd }: Workspace, { report, checkpoint, resumed }: Candidate) {
  // A null checkpoint means investigate-only, which never gets checks.
  if (!checkpoint || completionReviewReason({ autonomy: task.autonomy, report })) {
    if (resumed) emit("note", "Its agent had finished, so this task is going to review without resuming it");
    return;
  }
  const current = await reviewInputs(cwd, store.repoChecks(repo.id));
  const changed = changedInputs(checkpoint, current);
  const reusable = changed.length ? [] : checkpoint.passed;
  if (resumed) {
    const outcome = changed.length ? `${changed.join(", ")} changed, so all checks run again` : `${reusable.length} already passed on it`;
    emit("note", `Its agent had finished, so review checks are resuming on ${current.commit.slice(0, 7)} without it: ${outcome}`);
  }
  let validated: ReviewCheckpoint = { ...current, passed: [...reusable] };
  store.updateTask(task.id, { reviewCheckpoint: validated });
  report.validation ??= [];
  await runChecks(cwd, current.checks, "review", (check) => {
    report.validation!.push(check);
    if (check.status === "passed" && check.command) validated = { ...validated, passed: [...validated.passed, check.command] };
    // One write, so a pass is never counted without its evidence on the report.
    store.updateTask(task.id, { report, reviewCheckpoint: validated });
    emit("note", `Review check ${check.status}: ${check.command ?? "configuration"}`, { validation: check });
  }, signal, undefined, new Set(reusable));
}

/** Add the report's findings to the feed, leaving out any an earlier run already added. */
function recordFindings({ store }: WorkRunDeps, { task, emit }: WorkRun, report: Report) {
  const logged = new Set(store.listEvents(task.id).filter((e) => e.type === "finding").map((e) => e.message));
  for (const f of report.findings) {
    if (!logged.has(f.title)) emit("finding", f.title, { impact: f.impact, effort: f.effort });
  }
}

/** Record the report and send the task on: back to the operator, or to the merge queue if pre-approved. */
function fileOutcome({ store, log }: WorkRunDeps, { agent, task }: WorkRun, report: Report) {
  // No cost here: every run, including earlier interrupted ones, already added its own via the runs ledger.
  store.updateTask(task.id, { report });

  // Hold for the operator whenever there's something for them to decide, including unfinished scope.
  // Read back so required checks are judged against the candidate this run just finalized.
  const needsOperator =
    task.autonomy === "propose" ||
    (task.autonomy === "observe" && report.findings.length > 0) ||
    unmetAcceptance(store.getTask(task.id)!).length > 0;
  // A pre-approved task skips review and goes to the merge queue. Its checks passed above.
  const next = store.finishWork(task.id, needsOperator ? "needs_review" : "done");
  if (!next) return;
  store.bumpAgentCompleted(agent.id);
  log(`${agent.name} finished ${task.id}${next === "merging" ? ", pre-approved, so it's queued to merge" : ""}`);
}

export type WorkFailure = "cancelled" | "time_limit" | "factory_stopping" | "aborted" | "preparation_hold" | "turn_limit" | "other";

/** The state of the run's controller and factory when it failed. */
export interface WorkRunSignals {
  timeLimitHit: boolean;
  stopping: boolean;
  aborted: boolean;
}

/**
 * Why a run ended without finishing. The order matters: the time limit and a
 * stopping factory both abort the run too, so each must be ruled out before
 * reading an abort as the operator's cancellation.
 */
export function classifyWorkFailure(status: TaskStatus | undefined, error: unknown, signals: WorkRunSignals): WorkFailure {
  if (status === "cancelled") return "cancelled";
  if (signals.timeLimitHit) return "time_limit";
  if (signals.stopping) return "factory_stopping";
  if (signals.aborted) return "aborted";
  if (error instanceof PreparationHold) return "preparation_hold";
  if (error instanceof AgentRunError && error.opts.limit === "turns") return "turn_limit";
  return "other";
}

/** File a run that threw, by why it ended. What it cost is already on the task, via the runs ledger. */
export function handleWorkFailure(deps: WorkRunDeps, { agent, task, emit }: WorkRun, error: unknown, signals: WorkRunSignals) {
  const { store, log } = deps;
  const message = errorMessage(error);
  switch (classifyWorkFailure(store.getTask(task.id)?.status, error, signals)) {
    case "cancelled":
      // The operator cancelled it; that's already recorded.
      return;
    case "time_limit":
      emit("error", `Stopped after ${minutes(deps.timeLimitMin)}, the most a task may run. Raise it with crane serve --time-limit or CRANE_TIME_LIMIT_MIN`, { limit: "time" });
      store.setStatus(task.id, "failed", "Hit the time limit");
      log(`${agent.name} stopped ${task.id} at the time limit`);
      return;
    case "factory_stopping":
      // The factory is stopping, not the operator. The next factory carries on with it.
      deps.requeueStopped(task.id);
      return;
    case "aborted":
      store.setStatus(task.id, "cancelled", "Cancelled");
      return;
    case "preparation_hold":
      emit("error", message, { hold: true });
      store.setStatus(task.id, "failed", "Held before the agent started");
      log(`${agent.name} held ${task.id}: ${message}`);
      return;
    case "turn_limit":
      emit("error", message, { limit: "turns" });
      store.setStatus(task.id, "failed", "Hit the turn limit");
      log(`${agent.name} failed ${task.id}: ${message}`);
      return;
    case "other":
      emit("error", message);
      store.setStatus(task.id, "failed", "Failed");
      log(`${agent.name} failed ${task.id}: ${message}`);
  }
}

/** Tidy up after a run, however it ended. */
export function settleWorkRun({ store, recording, taskEnded }: WorkRunDeps, taskId: string) {
  const ended = store.getTask(taskId);
  // Only a task going back in the queue resumes from its checkpoint. Merge checks never read it.
  if (ended?.reviewCheckpoint && !["queued", "running"].includes(ended.status)) {
    recording(() => store.updateTask(taskId, { reviewCheckpoint: null }));
  }
  // If it failed or was cancelled, its worktree goes on the next tick.
  taskEnded(ended?.status);
}
