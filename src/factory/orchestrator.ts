import { crewSettingKey, type Store } from "../core/store.js";
import { driverLabel, isDriverName, type EventType, type Overview, type RunUsage, type Task } from "../core/types.js";
import { AgentRunError, type AgentDriver, type RunContext, type RunResult } from "../agents/driver.js";
import { combinedCost } from "../agents/codex-pricing.js";
import { join } from "node:path";
import { createWorktree, finalizeWorktree, removeWorktree } from "./git.js";
import { installDependencies } from "./deps.js";
import { deleteMergedBranch, landTask, MergeError } from "./merge.js";
import { runChecks } from "./checks.js";
import { DashboardBuilder } from "./dashboard.js";
import { DEFAULT_DRIVER_KEY, driverSettings, isAvailable } from "./drivers.js";
import { worktreesDir } from "../core/paths.js";
import { factoryBuildOutdated, servedDashboard } from "../core/webbuild.js";

const CREW = ["Jib", "Boom", "Hoist", "Trolley", "Rigger", "Winch", "Gantry", "Mast"];
const HEARTBEAT_KEY = "factory_heartbeat";

type CrewMember = { id: string; name: string };

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
const STOPPED_MESSAGE = "Stopped with the factory. Back in the queue to pick up where it left off";

export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_TIME_LIMIT_MIN = 90;

const envNumber = (name: string): number | undefined => {
  const v = process.env[name];
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
};

/**
 * Abort `ac` once `minutes` have passed. `hit()` says whether that's why it
 * was aborted, so the caller can tell a time limit from a cancellation.
 */
function timeLimit(ac: AbortController, minutes: number) {
  let hit = false;
  const timer = minutes > 0 ? setTimeout(() => ((hit = true), ac.abort()), minutes * 60_000) : null;
  timer?.unref();
  return { hit: () => hit, clear: () => timer && clearTimeout(timer) };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Cancelled"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const minutes = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

/** True if a factory process has checked in within the last few seconds. */
export function factoryIsRunning(store: Store): boolean {
  const beat = store.getSetting(HEARTBEAT_KEY);
  return !!beat && Date.now() - Number(beat) < 6000;
}

export function factoryDriverName(store: Store): string {
  return store.getSetting(DEFAULT_DRIVER_KEY) ?? "unknown";
}

/** The factory's state as the overview reports it: running, paused, its default agent, and the dashboard served. */
export function factoryState(store: Store): Overview["factory"] {
  const ui = servedDashboard();
  return {
    running: factoryIsRunning(store),
    paused: store.isPaused(),
    driver: factoryDriverName(store),
    factoryOutdated: factoryBuildOutdated(),
    uiOutdated: ui?.outdated ?? false,
    uiBuild: ui?.id ?? null,
    uiCommit: ui?.commit ?? null,
  };
}

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
  private mergingRepos = new Set<string>(); // repoIds with a merge in progress
  private crew: CrewMember[];
  private tickMs: number;
  private log: (line: string) => void;
  private dashboard: DashboardBuilder | null = null;
  readonly maxTurns: number;
  readonly timeLimitMin: number;
  private retryDelayMs: number;
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
    const size = Math.max(1, Math.min(CREW.length, opts.crewSize ?? Number(process.env.CRANE_AGENTS ?? 2)));
    this.crew = CREW.map((name) => ({ id: `a-${name.toLowerCase()}`, name }));
    for (const [i, a] of this.crew.entries()) {
      if (this.store.getSetting(crewSettingKey.active(a.id)) === null) {
        this.store.setSetting(crewSettingKey.active(a.id), String(i < size));
      }
    }
    this.tickMs = opts.tickMs ?? 1000;
    this.log = opts.log ?? (() => {});
    this.maxTurns = Math.max(0, opts.maxTurns ?? envNumber("CRANE_MAX_TURNS") ?? DEFAULT_MAX_TURNS);
    this.timeLimitMin = Math.max(0, opts.timeLimitMin ?? envNumber("CRANE_TIME_LIMIT_MIN") ?? DEFAULT_TIME_LIMIT_MIN);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? (envNumber("CRANE_RETRY_DELAY_SEC") ?? 60) * 1000);
    if (opts.buildDashboard) {
      this.dashboard = new DashboardBuilder({
        repo: () => this.store.listRepos().find((r) => r.isFactory) ?? null,
        log: this.log,
        note: (taskId, message) => this.store.addEvent(taskId, "note", message),
      });
    }
  }

  /**
   * Run the agent, giving a transient failure (overload, rate limit, network)
   * one more try after a pause. The retry resumes the same session when there
   * is one, so the agent picks up where it stopped instead of starting over.
   */
  private async runWithRetry(driver: AgentDriver, ctx: RunContext): Promise<RunResult> {
    try {
      return await driver.run(ctx);
    } catch (err) {
      if (ctx.signal.aborted || !(err instanceof AgentRunError) || !err.transient) throw err;
      // Jitter, so a crew that all hit the same overload doesn't come back at once.
      const wait = Math.round(this.retryDelayMs * (0.8 + Math.random() * 0.4));
      const reason = err.message.split("\n")[0]!.slice(0, 200).replace(/\.$/, "");
      ctx.emit("note", `${reason}. Trying once more in ${Math.max(1, Math.round(wait / 1000))}s`, { retry: true });
      await sleep(wait, ctx.signal);
      return driver.run({ ...ctx, resumeSession: err.sessionId ?? ctx.resumeSession });
    }
  }

  /** The operator's default agent, when this factory can run it; otherwise its first driver. */
  private defaultDriver(): AgentDriver {
    return this.drivers.get(this.store.getSetting(DEFAULT_DRIVER_KEY) ?? "") ?? this.drivers.values().next().value!;
  }

  /**
   * Who works a task: the agent the operator chose for it, else the one that
   * worked it last (it owns the task's session and knows the work so far),
   * else the crew member's preference, then the factory's default.
   */
  private driverFor(task: Task, agentId: string): AgentDriver {
    if (task.driver) {
      const chosen = this.drivers.get(task.driver);
      if (!chosen) throw new Error(`This task asks for ${driverLabel(task.driver)}, which this factory can't run`);
      return chosen;
    }
    const previous = this.drivers.get(this.store.lastWorkDriver(task.id) ?? "");
    if (previous) return previous;
    const preferred = this.store.crewDefaultDriver(agentId);
    if (preferred) {
      const driver = this.drivers.get(preferred);
      if (!driver) throw new Error(`This crew member asks for ${driverLabel(preferred)}, which this factory can't run`);
      return driver;
    }
    return this.defaultDriver();
  }

  start() {
    // Keep the operator's saved default if this factory can run it.
    const saved = this.store.getSetting(DEFAULT_DRIVER_KEY);
    if (!saved || !this.drivers.has(saved)) this.store.setSetting(DEFAULT_DRIVER_KEY, this.defaultDriver().name);
    for (const a of this.crew) {
      this.store.upsertAgent({ ...a, driver: this.defaultDriver().name });
      this.store.setAgentState(a.id, "idle", null);
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
    this.dashboard?.start().catch((err) => this.log(`Couldn't check the dashboard build: ${(err as Error).message}`));
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
      Promise.allSettled([...this.inflight, this.dashboard?.stop()]),
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
    this.store.updateTask(taskId, { status: "queued", agentId: null });
    this.store.addEvent(taskId, "status", message, { status: "queued" });
  }

  /** Track a job so `stop()` can wait for it. */
  private track(job: Promise<void>, agentId: string) {
    this.busy.add(agentId);
    const p = job.finally(() => {
      this.busy.delete(agentId);
      this.inflight.delete(p);
    });
    this.inflight.add(p);
  }

  private tick() {
    this.store.setSetting(HEARTBEAT_KEY, String(Date.now()));

    // Honour cancellations made from another process (e.g. the CLI).
    for (const [taskId, ac] of this.running) {
      if (this.store.getTask(taskId)?.status === "cancelled") ac.abort();
    }

    const paused = this.store.isPaused();
    for (const agent of this.crew) {
      if (this.busy.has(agent.id)) continue;
      this.store.setAgentState(agent.id, paused ? "paused" : "idle", null);
      if (paused || !this.store.crewActive(agent.id)) continue;
      // Approved merges first: the operator has already said yes and is waiting on them.
      const merge = this.store.claimNextMerge(agent.id, [...this.mergingRepos]);
      if (merge) {
        this.track(this.merge(agent, merge), agent.id);
        continue;
      }
      // A member with a maintenance role is kept for the runs the operator starts for it.
      const task = this.store.claimNextTask(agent.id, { onlyAssigned: this.store.crewRole(agent.id) !== null });
      if (!task) continue;
      this.track(this.work(agent, task), agent.id);
    }
  }

  /**
   * Run the driver with a row in the runs ledger around it, so every run's
   * cost lands on its task: succeeded, failed, or cancelled. A retry after a
   * transient failure counts toward the same run.
   */
  private async runAgent(
    agentId: string,
    driver: AgentDriver,
    ctx: Omit<RunContext, "onUsage" | "allowedTools" | "maxTurns" | "model" | "effort">,
  ): Promise<RunResult> {
    if (!(await isAvailable(driver))) {
      throw new Error(
        `${driverLabel(driver.name)} isn't installed where the factory runs, or didn't answer. Install it and restart the factory, or retry the task on another agent.`,
      );
    }
    this.store.setAgentDriver(agentId, driver.name);
    const runId = this.store.startRun({
      taskId: ctx.task.id,
      kind: ctx.job?.kind ?? "work",
      agentId,
      driver: driver.name,
    });
    let usage: RunUsage | null = null;
    // A driver can report more than once in a run (a failed resume, then a fresh session), so add them up.
    const onUsage = (u: RunUsage) => {
      const prev: RunUsage | null = usage;
      usage = !prev
        ? u
        : {
            ...combinedCost(prev, u),
            inputTokens: prev.inputTokens + u.inputTokens,
            outputTokens: prev.outputTokens + u.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + u.cacheReadTokens,
            cacheWriteTokens: prev.cacheWriteTokens + u.cacheWriteTokens,
            turns: prev.turns + u.turns,
            model: u.model ?? prev.model,
          };
    };
    // Read at the start of every run, so a change on the Crew page applies to the next one without a restart.
    const { model, effort } = driverSettings((k) => this.store.getSetting(k), driver.name);
    try {
      const result = await this.runWithRetry(driver, {
        ...ctx,
        onUsage,
        allowedTools: ctx.repo ? this.store.repoTools(ctx.repo.id).allowed : [],
        maxTurns: this.maxTurns || undefined,
        model: model ?? undefined,
        effort: effort ?? undefined,
      });
      this.store.finishRun(runId, "succeeded", usage);
      return result;
    } catch (err) {
      const cancelled = ctx.signal.aborted || this.store.getTask(ctx.task.id)?.status === "cancelled";
      this.store.finishRun(runId, cancelled ? "cancelled" : "failed", usage);
      throw err;
    }
  }

  /** Record events on one task's feed. */
  private emitter(taskId: string) {
    return (type: EventType, message: string, data?: Record<string, unknown>) =>
      this.store.addEvent(taskId, type, message, data ?? null);
  }

  /** Land an approved task on its repo's default branch, with an agent on hand for conflicts. */
  private async merge(agent: CrewMember, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
    if (repo) this.mergingRepos.add(repo.id);
    this.store.setAgentState(agent.id, "working", task.id);
    this.log(`${agent.name} is merging ${task.id} · ${task.title}`);
    const emit = this.emitter(task.id);
    // Stopping the factory aborts every running controller; merges are tracked under their own key.
    this.running.set(`merge:${task.id}`, ac);

    try {
      if (!repo) throw new MergeError("This task has no repo to merge into");
      if (!task.branch) throw new MergeError("This task has no branch to merge");
      const workdir = task.worktree ?? join(worktreesDir(), task.id);
      this.store.updateTask(task.id, { worktree: workdir });

      const result = await landTask({
        repo,
        task,
        workdir,
        emit,
        signal: ac.signal,
        checks: this.store.repoChecks(repo.id),
        recordValidation: (run) => {
          const report = this.store.getTask(task.id)?.report ?? { summary: "", findings: [], changedFiles: [] };
          this.store.updateTask(task.id, { report: { ...report, validation: [...(report.validation ?? []), run] } });
          emit("note", `Merge check ${run.status}: ${run.command ?? "configuration"}`, { validation: run });
        },
        resolveConflicts: async ({ cwd, base, files }) => {
          try {
            const note = await installDependencies(cwd, { from: repo.path, signal: ac.signal });
            if (note) emit("note", note);
          } catch {
            // Not fatal: resolving conflicts rarely needs a build.
          }
          const current = this.store.getTask(task.id)!;
          const r = await this.runAgent(agent.id, this.driverFor(current, agent.id), {
            task: current,
            repo,
            cwd,
            signal: ac.signal,
            emit,
            job: { kind: "resolve_conflicts", base, files },
            // landTask runs these as merge checks once the conflicts are resolved.
            checks: this.store.repoChecks(repo.id),
          });
          for (const f of r.report.findings) emit("finding", f.title, { impact: f.impact, effort: f.effort });
        },
      });

      const main = repo.defaultBranch;
      const where = result.pushedTo ? ` and pushed to ${result.pushedTo}` : "";
      const message = result.checkoutBehind
        ? `Merged into ${main}${where}. Your checkout at ${result.checkoutBehind} has local changes, so it wasn't updated`
        : `Merged into ${main}${where}`;
      // Record the outcome before cleaning up: if the merge just updated Crane's own
      // checkout, a dev server may restart any moment.
      this.store.completeMerge(task.id, message, {
        merge: { commit: result.commit, pushedTo: result.pushedTo, checkoutBehind: result.checkoutBehind },
      });
      this.log(`${agent.name} merged ${task.id}`);
      await removeWorktree(repo, workdir);
      if (!result.checkoutBehind) await deleteMergedBranch(repo, task.branch);
      // A change to Crane itself: build the dashboard from it, so it shows without anyone running npm run build.
      if (repo.isFactory) this.dashboard?.request(result.head, task.id).catch(() => {});
    } catch (err) {
      if (ac.signal.aborted && !limit.hit()) {
        // The factory is stopping. Leave it waiting; the next factory picks it up again.
        this.store.updateTask(task.id, { agentId: null });
        return;
      }
      const message = limit.hit()
        ? `Merging took longer than ${minutes(this.timeLimitMin)}, the most a task may run`
        : err instanceof Error
          ? err.message
          : String(err);
      emit("error", message, limit.hit() ? { limit: "time" } : undefined);
      this.store.setStatus(task.id, "needs_review", "Couldn't merge. Back with you", { merge: { error: message } });
      this.log(`${agent.name} couldn't merge ${task.id}: ${message}`);
    } finally {
      limit.clear();
      this.running.delete(`merge:${task.id}`);
      if (repo) this.mergingRepos.delete(repo.id);
      this.store.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }

  private async work(agent: CrewMember, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    this.running.set(task.id, ac);
    this.store.setAgentState(agent.id, "working", task.id);
    // A task that already has a session was interrupted by a restart. Its agent carries on.
    const resuming = !!task.sessionId;
    this.log(`${agent.name} ${resuming ? "is resuming" : "picked up"} ${task.id} · ${task.title}`);
    const emit = this.emitter(task.id);

    try {
      const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
      if (!repo) throw new Error("This task has no repo to work in");

      let cwd = repo.path;
      if (task.autonomy !== "observe") {
        // Reuses the worktree if an earlier run left one, so nothing done so far is lost.
        const wt = await createWorktree(repo, task);
        cwd = wt.path;
        this.store.updateTask(task.id, { branch: wt.branch, worktree: wt.path });
        emit("note", `${task.worktree ? "Back on" : "Working on"} branch ${wt.branch}`, { branch: wt.branch });
        try {
          const note = await installDependencies(wt.path, { from: repo.path, signal: ac.signal });
          if (note) emit("note", note);
        } catch (err) {
          if (ac.signal.aborted) throw err;
          // Not fatal: the agent can still read code and may be able to install itself.
          emit("note", `Couldn't install dependencies: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      const driver = this.driverFor(task, agent.id);
      // A session belongs to the agent that started it. Older runs didn't record theirs, so trust those.
      const owner = this.store.lastWorkDriver(task.id);
      const resumable = !!task.sessionId && (!isDriverName(owner) || owner === driver.name);
      if (task.sessionId && !resumable) {
        emit("note", `Switching to ${driverLabel(driver.name)}, which starts a new session on the work so far`);
      }
      const result = await this.runAgent(agent.id, driver, {
        task: this.store.getTask(task.id)!,
        repo,
        cwd,
        signal: ac.signal,
        emit,
        resumeSession: resumable ? task.sessionId! : undefined,
        onSession: (sessionId) => this.store.updateTask(task.id, { sessionId }),
        // Run below as review checks. Investigate-only runs get none.
        checks: task.autonomy !== "observe" ? this.store.repoChecks(repo.id) : undefined,
      });

      if (task.autonomy !== "observe") {
        const changed = await finalizeWorktree(repo, task, cwd);
        result.report.changedFiles = [...new Set([...changed, ...result.report.changedFiles])];
        result.report.validation = this.store.getTask(task.id)?.report?.validation ?? [];
        this.store.updateTask(task.id, { report: result.report });
        await runChecks(cwd, this.store.repoChecks(repo.id), "review", (run) => {
          result.report.validation!.push(run);
          this.store.updateTask(task.id, { report: result.report });
          emit("note", `Review check ${run.status}: ${run.command ?? "configuration"}`, { validation: run });
        }, ac.signal);
      }
      const logged = new Set(this.store.listEvents(task.id).filter((e) => e.type === "finding").map((e) => e.message));
      for (const f of result.report.findings) {
        if (!logged.has(f.title)) emit("finding", f.title, { impact: f.impact, effort: f.effort });
      }

      // No cost here: every run, including earlier interrupted ones, already added its own via the runs ledger.
      this.store.updateTask(task.id, { report: result.report });

      // Hold for the operator whenever there's something for them to decide.
      const needsOperator =
        task.autonomy === "propose" || (task.autonomy === "observe" && result.report.findings.length > 0);
      if (this.store.getTask(task.id)?.status === "cancelled") return;
      this.store.setStatus(task.id, needsOperator ? "needs_review" : "done", needsOperator ? "Ready for your review" : "Done");
      this.store.bumpAgentCompleted(agent.id);
      this.log(`${agent.name} finished ${task.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // What a failed run cost is already on the task, via the runs ledger.
      const status = this.store.getTask(task.id)?.status;
      if (status === "cancelled") {
        // The operator cancelled it; that's already recorded.
      } else if (limit.hit()) {
        const why = `Stopped after ${minutes(this.timeLimitMin)}, the most a task may run. Raise it with crane serve --time-limit or CRANE_TIME_LIMIT_MIN`;
        emit("error", why, { limit: "time" });
        this.store.setStatus(task.id, "failed", "Hit the time limit");
        this.log(`${agent.name} stopped ${task.id} at the time limit`);
      } else if (this.stopping) {
        // The factory is stopping, not the operator. The next factory carries on with it.
        this.requeue(task.id, STOPPED_MESSAGE);
      } else if (ac.signal.aborted) {
        this.store.setStatus(task.id, "cancelled", "Cancelled");
      } else {
        const turns = err instanceof AgentRunError && err.opts.limit === "turns";
        emit("error", message, turns ? { limit: "turns" } : undefined);
        this.store.setStatus(task.id, "failed", turns ? "Hit the turn limit" : "Failed");
        this.log(`${agent.name} failed ${task.id}: ${message}`);
      }
    } finally {
      limit.clear();
      this.running.delete(task.id);
      this.store.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }
}
