import { crewSettingKey, type RunnerJobRecord, type Store } from "@crane/storage";
import { errorMessage, type AgentState, type EventType, type RunnerSummary, type Task } from "@crane/contracts";
import type { AgentDriver } from "@crane/agent-protocol";
import type { AgentRunnerDeps } from "./agent-runner.js";
import { defaultDriver } from "./driver-selection.js";
import { DashboardBuilder } from "./dashboard.js";
import { handleMergeFailure, runMerge, type MergeRun, type MergeRunDeps } from "./merge-run.js";
import { envNumber, FactoryStopping, timeLimit } from "./run-limits.js";
import { isLaneMember, keptJob, laneMembers, waitingReturn } from "./runner-lane.js";
import { DEFAULT_DRIVER_KEY, DEFAULT_MAX_TURNS, DEFAULT_TIME_LIMIT_MIN, HEARTBEAT_KEY } from "./settings.js";
import { StorageMaintenance } from "@crane/storage";
import { OperatorActions } from "./actions.js";
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
  /** How often a run sent to a container checks on its job. Default 1000ms. */
  remotePollMs?: number;
}

/**
 * How long `stop()` waits for agents to wind down and record where they got to.
 * `tsx watch` (npm run dev) force-kills the factory 5s after asking it to stop.
 */
const STOP_GRACE_MS = 3500;
/** Leave room for tick jitter within the six-second freshness window. */
const HEARTBEAT_MS = 3000;
const STOPPED_MESSAGE = "Stopped with the factory. Back in the queue to pick up where it left off";
const EXPIRED_MESSAGE = "Its container stopped answering, so its job expired. Back in the queue to pick up where it left off";

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
  /** Running container tasks whose container kept working them through a restart, waiting for their lane. */
  private kept = new Set<string>();
  private crew: CrewMember[];
  private tickMs: number;
  private log: (line: string) => void;
  private dashboard: DashboardBuilder | null = null;
  readonly maxTurns: number;
  readonly timeLimitMin: number;
  private agentRunner: AgentRunnerDeps;
  private sweeper: WorktreeSweeper;
  private workRun: WorkRunDeps;
  private mergeRun: MergeRunDeps;
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
      remote: { pollMs: opts.remotePollMs ?? 1000 },
    };
    if (opts.buildDashboard) {
      this.dashboard = new DashboardBuilder({
        repo: () => this.store.listRepos().find((r) => r.isFactory) ?? null,
        log: this.log,
        note: (taskId, message) => this.recording(() => this.store.addEvent(taskId, "note", message)),
      });
    }
    this.mergeRun = {
      store,
      drivers: this.drivers,
      agentRunner: this.agentRunner,
      timeLimitMin: this.timeLimitMin,
      log: this.log,
      dashboard: this.dashboard,
      remote: this.workRun.remote,
    };
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
    // A container still leased on a task's job is still working it, so that task stays
    // running and its lane waits on the same job. One that returned its commits while
    // the factory was down stays running too, for its lane to apply them.
    this.kept.clear();
    for (const m of this.store.listTasks({ status: ["running"] })) {
      if (!this.requeue(m.id, "The factory stopped unexpectedly. Back in the queue to pick up where it left off")) {
        const returned = waitingReturn(this.store, m.id);
        this.store.addEvent(m.id, "note", returned
          ? "The factory restarted after its container returned its work"
          : "The factory restarted while its container kept working on it");
      }
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
    // The reason tells a container's run to leave its job working, for the next factory.
    for (const ac of this.running.values()) ac.abort(new FactoryStopping());

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

  /**
   * Put a running task back in the queue, keeping its worktree and session for
   * the next agent. A container task whose job is still leased, or returned
   * with commits not yet applied, stays running instead, for its lane to pick
   * up again; that returns false.
   */
  private requeue(taskId: string, message: string): boolean {
    const task = this.store.getTask(taskId);
    if (task?.status !== "running") return true;
    if (task.runnerId && keptJob(this.store, taskId)) {
      this.kept.add(taskId);
      return false;
    }
    this.store.closeUnresolvedCommands(taskId);
    this.store.updateTask(taskId, { status: "queued", agentId: null });
    this.store.addEvent(taskId, "status", message, { status: "queued" });
    return true;
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
    // Lane slots aren't crew: the task's own status and agent id say what they're doing.
    if (isLaneMember(id)) return;
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
    const pending = paused ? { queued: false, merging: false, runners: [] } : this.store.pendingWork();
    this.assignLanes(pending.runners);
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
   * Container lanes: each online container works its own routed tasks, as many
   * at once as its capacity, without taking a crew slot. Tasks a container kept
   * working through a restart come first, since they already hold its capacity.
   * Their runs continue while paused; `runnerIds` is empty then, so nothing new starts.
   */
  private assignLanes(runnerIds: readonly string[]) {
    const now = Date.now();
    this.handBackExpired(this.store.runners.expireLeases(new Date(now).toISOString()));
    this.resumeKept(now);
    for (const runnerId of runnerIds) {
      const runner = this.store.runners.summary(runnerId, now);
      // An offline container's tasks wait queued until it checks in again.
      if (!runner?.online) continue;
      for (const member of this.freeSlots(runner)) {
        const task = this.store.claimNextRunnerTask(runner.id, member.id);
        if (!task) break;
        this.track(this.work(member, task), member.id, task.id);
      }
    }
  }

  private freeSlots(runner: RunnerSummary): CrewMember[] {
    return laneMembers(runner).filter((m) => !this.busy.has(m.id));
  }

  /** Jobs whose lease ran out with no run here waiting on them: their tasks go back in the queue. */
  private handBackExpired(jobs: RunnerJobRecord[]) {
    for (const job of jobs) {
      this.kept.delete(job.taskId);
      if (!this.running.has(job.taskId)) this.requeue(job.taskId, EXPIRED_MESSAGE);
    }
  }

  /**
   * Wait again on the jobs containers kept working while the factory restarted,
   * once each is back online with room. A job already returned needs nothing
   * more from its container, so it is applied whether or not it is online.
   */
  private resumeKept(now: number) {
    for (const taskId of this.kept) {
      const task = this.store.getTask(taskId);
      if (!task?.runnerId || task.status !== "running" || this.running.has(taskId)) {
        this.kept.delete(taskId);
        continue;
      }
      // Its job ended while nobody waited on it (cancelled, say): it runs again from the queue.
      if (this.requeue(taskId, STOPPED_MESSAGE)) {
        this.kept.delete(taskId);
        continue;
      }
      const runner = this.store.runners.summary(task.runnerId, now);
      const ready = runner?.online || waitingReturn(this.store, taskId);
      const member = runner && ready ? this.freeSlots(runner)[0] : undefined;
      if (!member) continue;
      this.kept.delete(taskId);
      this.store.updateTask(taskId, { agentId: member.id });
      this.track(this.work(member, { ...task, agentId: member.id }), member.id, taskId);
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

  /** Track one agent's landing of a task: its controller, time limit, repo slot and agent state. The merge itself is in `merge-run.ts`. */
  private async merge(agent: CrewMember, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
    if (repo) this.mergingRepos.add(repo.id);
    this.setAgentState(agent.id, "working", task.id);
    this.log(`${agent.name} is merging ${task.id} · ${task.title}`);
    const run: MergeRun = { agent, task, repo, signal: ac.signal, emit: this.emitter(task.id) };
    // Stopping the factory aborts every running controller; merges are tracked under their own key.
    this.running.set(`merge:${task.id}`, ac);

    try {
      await runMerge(this.mergeRun, run);
    } catch (err) {
      handleMergeFailure(this.mergeRun, run, err, { timeLimitHit: limit.hit(), aborted: ac.signal.aborted });
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
