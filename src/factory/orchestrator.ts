import { crewSettingKey, type Store } from "../core/store.js";
import { errorMessage, type AgentState, type EventType, type Task } from "@crane/contracts";
import type { AgentDriver } from "@crane/agent-protocol";
import { join } from "node:path";
import { runAgent, type AgentRunnerDeps } from "./agent-runner.js";
import { defaultDriver, driverFor } from "./driver-selection.js";
import { removeWorktree } from "./git.js";
import { deleteMergedBranch, landTask, MergeError } from "./merge.js";
import { DashboardBuilder } from "./dashboard.js";
import { envNumber, minutes, timeLimit } from "./run-limits.js";
import { DEFAULT_DRIVER_KEY, DEFAULT_MAX_TURNS, DEFAULT_TIME_LIMIT_MIN, HEARTBEAT_KEY } from "./settings.js";
import { worktreesDir } from "../core/paths.js";
import { retainScreenshots } from "../core/screenshots.js";
import { StorageMaintenance } from "../core/retention.js";
import { OperatorActions } from "./actions.js";
import { hasVisualDecision, requireCandidateVisualReview, visualReviewRequired } from "./visual-review.js";
import { handleWorkFailure, runWork, settleWorkRun, type CrewMember, type WorkRun, type WorkRunDeps } from "./work-run.js";
import { WorktreeSweeper } from "./worktree-sweeper.js";

const CREW = ["Jib", "Boom", "Hoist", "Trolley", "Rigger", "Winch", "Gantry", "Mast"];

export interface FactoryOptions {
  crewSize?: number;
  tickMs?: number;
  log?: (line: string) => void;
  /**
   * Build the dashboard from each merged commit of Crane's own repo, so it's
   * served instead of the checkout's web/dist. See `dashboard.ts`.
   */
  buildDashboard?: boolean;
  /** Most turns one agent run may take. Default CRANE_MAX_TURNS, or 200. 0 for no limit. */
  maxTurns?: number;
  /** Most minutes a task may hold a crew slot. Default CRANE_TIME_LIMIT_MIN, or 90. 0 for no limit. */
  timeLimitMin?: number;
  /** How long to wait before retrying a transient failure, before jitter. Default CRANE_RETRY_DELAY_SEC, or 60s. */
  retryDelayMs?: number;
}

/**
 * How long `stop()` waits for agents to wind down and record where they got to.
 * `tsx watch` (npm run dev) force-kills the factory 5s after asking it to stop.
 */
const STOP_GRACE_MS = 3500;
/** Leave room for tick jitter within the six-second freshness window. */
const HEARTBEAT_MS = 3000;
const STOPPED_MESSAGE = "Stopped with the factory. Back in the queue to pick up where it left off";

/**
 * The factory floor. Keeps a crew of agents busy: each idle agent claims the
 * oldest queued task, works it through the driver, and files the result.
 * State lives in the store, so the CLI and UI can steer it from anywhere.
 */
export class Factory {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, AbortController>(); // taskId -> abort
  private inflight = new Set<Promise<void>>(); // every work() and merge() under way
  private stopping = false;
  private busy = new Set<string>(); // agentIds
  /** Only the factory writes agent state; operator choices remain in the store. */
  private agentStates = new Map<string, { state: AgentState; taskId: string | null }>();
  private lastHeartbeat: number | null = null;
  private mergingRepos = new Set<string>(); // repoIds with a merge in progress
  private crew: CrewMember[];
  private tickMs: number;
  private log: (line: string) => void;
  private dashboard: DashboardBuilder | null = null;
  readonly maxTurns: number;
  readonly timeLimitMin: number;
  private agentRunner: AgentRunnerDeps;
  private sweeper: WorktreeSweeper;
  private workRun: WorkRunDeps;
  /** Why the last tick failed, so a store that stays broken is reported once rather than every tick. */
  private tickError: string | null = null;
  private storageMaintenance: StorageMaintenance;
  /** Every agent this factory can run, by name. The first is the default until the operator picks one. */
  private drivers: Map<string, AgentDriver>;

  constructor(
    private store: Store,
    drivers: AgentDriver | AgentDriver[],
    opts: FactoryOptions = {},
  ) {
    const list = Array.isArray(drivers) ? drivers : [drivers];
    if (!list.length) throw new Error("The factory needs at least one agent driver");
    this.drivers = new Map(list.map((d) => [d.name, d]));
    const size = Math.max(1, Math.min(CREW.length, opts.crewSize ?? envNumber("CRANE_AGENTS") ?? 2));
    this.crew = CREW.map((name) => ({ id: `a-${name.toLowerCase()}`, name }));
    for (const [i, a] of this.crew.entries()) {
      if (this.store.getSetting(crewSettingKey.active(a.id)) === null) {
        this.store.setSetting(crewSettingKey.active(a.id), String(i < size));
      }
    }
    this.tickMs = opts.tickMs ?? 1000;
    this.log = opts.log ?? (() => {});
    this.storageMaintenance = new StorageMaintenance(store, this.log);
    this.maxTurns = Math.max(0, opts.maxTurns ?? envNumber("CRANE_MAX_TURNS") ?? DEFAULT_MAX_TURNS);
    this.timeLimitMin = Math.max(0, opts.timeLimitMin ?? envNumber("CRANE_TIME_LIMIT_MIN") ?? DEFAULT_TIME_LIMIT_MIN);
    this.agentRunner = {
      store,
      maxTurns: this.maxTurns,
      retryDelayMs: Math.max(0, opts.retryDelayMs ?? (envNumber("CRANE_RETRY_DELAY_SEC") ?? 60) * 1000),
    };
    this.sweeper = new WorktreeSweeper({
      store,
      log: this.log,
      inUse: (taskId) => this.running.has(taskId) || this.running.has(`merge:${taskId}`),
      stopping: () => this.stopping,
    });
    this.workRun = {
      store,
      drivers: this.drivers,
      agentRunner: this.agentRunner,
      timeLimitMin: this.timeLimitMin,
      log: this.log,
      recording: (write) => this.recording(write),
      requeueStopped: (taskId) => this.requeue(taskId, STOPPED_MESSAGE),
      taskEnded: (status) => this.sweeper.taskEnded(status),
    };
    if (opts.buildDashboard) {
      this.dashboard = new DashboardBuilder({
        repo: () => this.store.listRepos().find((r) => r.isFactory) ?? null,
        log: this.log,
        note: (taskId, message) => this.recording(() => this.store.addEvent(taskId, "note", message)),
      });
    }
  }

  start() {
    this.store.closeUnresolvedCommands();
    // Keep the operator's saved default if this factory can run it.
    const saved = this.store.getSetting(DEFAULT_DRIVER_KEY);
    if (!saved || !this.drivers.has(saved)) this.store.setSetting(DEFAULT_DRIVER_KEY, defaultDriver(this.store, this.drivers).name);
    this.lastHeartbeat = null;
    this.agentStates = new Map(this.store.listAgents().map(a => [a.id, { state: a.state, taskId: a.taskId }]));
    for (const a of this.crew) {
      this.store.upsertAgent({ ...a, driver: defaultDriver(this.store, this.drivers).name });
      this.setAgentState(a.id, "idle", null);
    }
    this.store.pruneAgents(this.crew.map((a) => a.id));

    // A previous factory stopped without getting to put its work back (it crashed,
    // or was killed before it could). Requeue it; the agent picks up where it left off.
    for (const m of this.store.listTasks({ status: ["running"] })) {
      this.requeue(m.id, "The factory stopped unexpectedly. Back in the queue to pick up where it left off");
    }
    // Runs it was in the middle of never reported their usage. Close them so they don't read as live.
    this.store.closeStaleRuns();
    // Merges are safe to run again from the top, so just release them.
    for (const m of this.store.listTasks({ status: ["merging"] })) {
      if (m.agentId) this.store.updateTask(m.id, { agentId: null });
    }

    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.tick();
    this.dashboard?.start().catch((err) => this.log(`Couldn't check the dashboard build: ${errorMessage(err)}`));
  }

  /**
   * Stop taking work and wind down. Nothing in flight is cancelled: tasks go
   * back in the queue with their worktree and agent session, and merges wait
   * to run again, so the next factory carries on where this one stopped.
   */
  async stop(opts: { graceMs?: number } = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    for (const ac of this.running.values()) ac.abort();

    // Give agents a moment to exit, so their last events and the requeue are recorded in order.
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight, this.sweeper.inProgress, this.dashboard?.stop()]),
      new Promise((r) => (timeout = setTimeout(r, opts.graceMs ?? STOP_GRACE_MS))),
    ]);
    clearTimeout(timeout);
    // Anything still winding down is requeued now, before the process exits under it.
    for (const id of this.running.keys()) {
      if (!id.startsWith("merge:")) this.requeue(id, STOPPED_MESSAGE);
    }
    this.store.setSetting(HEARTBEAT_KEY, "0");
  }

  /** Put a running task back in the queue, keeping its worktree and session for the next agent. */
  private requeue(taskId: string, message: string) {
    if (this.store.getTask(taskId)?.status !== "running") return;
    this.store.closeUnresolvedCommands(taskId);
    this.store.updateTask(taskId, { status: "queued", agentId: null });
    this.store.addEvent(taskId, "status", message, { status: "queued" });
  }

  /**
   * Track a job so `stop()` can wait for it. Jobs record their own failures, so
   * one only rejects when recording failed too. The other agents keep working;
   * `start()` recovers this task, whose status is out of date until then.
   */
  private track(job: Promise<void>, agentId: string, taskId: string) {
    this.busy.add(agentId);
    const p = job
      .catch((err) => this.log(`Couldn't record how ${taskId} ended: ${errorMessage(err)}. Restart the factory to pick it up again`))
      .finally(() => {
        this.busy.delete(agentId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  private sweepWorktrees() {
    this.sweeper.sweep();
  }

  /** One bad tick (a locked or full database, say) mustn't end every agent's run. The next one tries again. */
  private tick() {
    try {
      this.storageMaintenance.tick();
      this.store.syncGoals();
      this.assignWork();
      this.tickError = null;
    } catch (err) {
      const message = errorMessage(err);
      if (message !== this.tickError) this.log(`Couldn't check for work: ${message}. Trying again`);
      this.tickError = message;
    }
  }

  private setAgentState(id: string, state: AgentState, taskId: string | null) {
    const previous = this.agentStates.get(id);
    if (previous?.state === state && previous.taskId === taskId) return;
    this.store.setAgentState(id, state, taskId);
    // Cache only successful writes, so the next tick retries a failed transition.
    this.agentStates.set(id, { state, taskId });
  }

  private assignWork() {
    const now = Date.now();
    if (this.lastHeartbeat === null || now - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.store.setSetting(HEARTBEAT_KEY, String(now));
      this.lastHeartbeat = now;
    }
    new OperatorActions(this.store).fireCrewSchedules();

    // Honour cancellations made from another process (e.g. the CLI).
    for (const [taskId, ac] of this.running) {
      if (this.store.getTask(taskId)?.status === "cancelled") ac.abort();
    }
    this.sweepWorktrees();

    const paused = this.store.isPaused();
    const pending = paused ? { queued: false, merging: false } : this.store.pendingWork();
    for (const agent of this.crew) {
      if (this.busy.has(agent.id)) continue;
      this.setAgentState(agent.id, paused ? "paused" : "idle", null);
      if (paused || (!pending.queued && !pending.merging)) continue;
      const active = this.store.crewActive(agent.id);
      // Approved merges first: the operator has already said yes and is waiting on them.
      const merge = active && pending.merging ? this.store.claimNextMerge(agent.id, [...this.mergingRepos]) : null;
      if (merge) {
        this.track(this.merge(agent, merge), agent.id, merge.id);
        continue;
      }
      const task = pending.queued ? this.claimNextTask(agent.id, active) : null;
      if (!task) continue;
      this.track(this.work(agent, task), agent.id, task.id);
    }
  }

  /**
   * A member with a maintenance role is kept for the runs the operator starts for it.
   * An on-call member comes in only for the post-mortems the operator named them for.
   */
  private claimNextTask(agentId: string, active: boolean) {
    const scope = active ? { onlyAssigned: this.store.crewRole(agentId) !== null } : { onlyPostmortems: true };
    return this.store.claimNextTask(agentId, scope);
  }

  /**
   * A write made for a driver callback. Drivers call these from child-process
   * listeners, where a throw is uncaught and ends the factory, so a failed write
   * costs that one update and nothing else.
   */
  private recording(write: () => void) {
    try {
      write();
    } catch (err) {
      this.log(`Couldn't record a task update: ${errorMessage(err)}`);
    }
  }

  /** Record events on one task's feed. */
  private emitter(taskId: string) {
    return (type: EventType, message: string, data?: Record<string, unknown>) =>
      this.recording(() => this.store.addEvent(taskId, type, message, data ?? null));
  }

  /** Land an approved task on its repo's default branch, with an agent on hand for conflicts. */
  private async merge(agent: CrewMember, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
    if (repo) this.mergingRepos.add(repo.id);
    this.setAgentState(agent.id, "working", task.id);
    this.log(`${agent.name} is merging ${task.id} · ${task.title}`);
    const emit = this.emitter(task.id);
    // Stopping the factory aborts every running controller; merges are tracked under their own key.
    this.running.set(`merge:${task.id}`, ac);

    try {
      if (!repo) throw new MergeError("This task has no repo to merge into");
      if (!task.branch) throw new MergeError("This task has no branch to merge");
      const workdir = task.worktree ?? join(worktreesDir(), task.id);
      this.store.updateTask(task.id, { worktree: workdir });
      let conflictChangedUi = false;
      const runResolver = async (ctx: { cwd: string; base: string; files: string[]; deferredDependencies?: string[]; checkpoint?: string; visualReviewRequired?: boolean }) => {
        const { cwd, base, files, deferredDependencies, checkpoint } = ctx;
        conflictChangedUi ||= ctx.visualReviewRequired ?? false;
        const current = this.store.getTask(task.id)!;
        const r = await runAgent(this.agentRunner, agent.id, driverFor(this.store, this.drivers, current, agent.id), {
          task: current, repo, cwd, signal: ac.signal, emit,
          job: { kind: "resolve_conflicts", phase: checkpoint ? "validate" : "edit", base, files,
            ...(checkpoint ? { checkpoint } : {}), ...(deferredDependencies ? { deferredDependencies } : {}) },
          checks: this.store.repoChecks(repo.id),
        });
        conflictChangedUi ||= visualReviewRequired({ ...r.report, changedFiles: [...r.report.changedFiles, ...files] });
        if (r.report.screenshots?.length) {
          const screenshots = retainScreenshots(task.id, cwd, r.report.screenshots, message => emit("note", message));
          const report = this.store.getTask(task.id)?.report;
          if (report && screenshots.length) this.store.updateTask(task.id, { report: { ...report, screenshots } });
        }
        for (const f of r.report.findings) emit("finding", f.title, { impact: f.impact, effort: f.effort });
        return { visualReviewRequired: conflictChangedUi };
      };

      const result = await landTask({
        repo,
        task,
        workdir,
        emit,
        signal: ac.signal,
        checks: this.store.repoChecks(repo.id),
        reviewedCandidate: hasVisualDecision(task.visualReview) ? task.visualReview.commit : undefined,
        verifyVisualReview: async (commit, tree, branchCommit, changedFiles) => requireCandidateVisualReview(this.store, task.id, commit, tree, branchCommit, changedFiles, conflictChangedUi),
        recordValidation: (run) => {
          const report = this.store.getTask(task.id)?.report ?? { summary: "", findings: [], changedFiles: [] };
          this.store.updateTask(task.id, { report: { ...report, validation: [...(report.validation ?? []), run] } });
          emit("note", `Merge check ${run.status}: ${run.command ?? "configuration"}`, { validation: run });
        },
        resolveConflicts: runResolver,
        validateResolution: runResolver,
      });

      const main = repo.defaultBranch;
      const where = result.pushedTo ? ` and pushed to ${result.pushedTo}` : "";
      const message = result.checkoutBehind
        ? `Merged into ${main}${where}. Your checkout at ${result.checkoutBehind} has local changes, so it wasn't updated`
        : `Merged into ${main}${where}`;
      // Record the outcome before cleaning up: if the merge just updated Crane's own
      // checkout, a dev server may restart any moment.
      this.store.completeMerge(task.id, message, {
        merge: { commit: result.commit, head: result.head, pushedTo: result.pushedTo, checkoutBehind: result.checkoutBehind },
      });
      this.log(`${agent.name} merged ${task.id}`);
      await removeWorktree(repo, workdir);
      if (!result.checkoutBehind) await deleteMergedBranch(repo, task.branch);
      // A change to Crane itself: build the dashboard from it, so it shows without anyone running npm run build.
      if (repo.isFactory) this.dashboard?.request(result.head, task.id).catch((err) => this.log(`Couldn't start the dashboard build: ${errorMessage(err)}`));
    } catch (err) {
      if (ac.signal.aborted && !limit.hit()) {
        // The factory is stopping. Leave it waiting; the next factory picks it up again.
        this.store.updateTask(task.id, { agentId: null });
        return;
      }
      const message = limit.hit()
        ? `Merging took longer than ${minutes(this.timeLimitMin)}, the most a task may run`
        : errorMessage(err);
      emit("error", message, limit.hit() ? { limit: "time" } : undefined);
      this.store.setStatus(task.id, "needs_review", "Couldn't merge. Back with you", { merge: { error: message } });
      this.log(`${agent.name} couldn't merge ${task.id}: ${message}`);
    } finally {
      limit.clear();
      this.running.delete(`merge:${task.id}`);
      if (repo) this.mergingRepos.delete(repo.id);
      this.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }

  /** Track one agent's run of a task: its controller, time limit and agent state. The run itself is in `work-run.ts`. */
  private async work(agent: CrewMember, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    this.running.set(task.id, ac);
    this.setAgentState(agent.id, "working", task.id);
    // A task that already has a session was interrupted by a restart. Its agent carries on.
    const resuming = !!task.sessionId;
    this.log(`${agent.name} ${resuming ? "is resuming" : "picked up"} ${task.id} · ${task.title}`);
    const run: WorkRun = { agent, task, signal: ac.signal, emit: this.emitter(task.id) };

    try {
      await runWork(this.workRun, run);
    } catch (err) {
      handleWorkFailure(this.workRun, run, err, { timeLimitHit: limit.hit(), stopping: this.stopping, aborted: ac.signal.aborted });
    } finally {
      limit.clear();
      this.running.delete(task.id);
      settleWorkRun(this.workRun, task.id);
      this.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }
}
