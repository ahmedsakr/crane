import type { Store } from "../core/store.js";
import type { Task } from "../core/types.js";
import { AgentRunError, type AgentDriver, type RunContext, type RunResult } from "../agents/driver.js";
import { join } from "node:path";
import { createWorktree, finalizeWorktree, removeWorktree } from "./git.js";
import { installDependencies } from "./deps.js";
import { deleteMergedBranch, landTask, MergeError } from "./merge.js";
import { worktreesDir } from "../core/paths.js";

const CREW = ["Jib", "Boom", "Hoist", "Trolley", "Rigger", "Winch", "Gantry", "Mast"];
const HEARTBEAT_KEY = "factory_heartbeat";
const DRIVER_KEY = "factory_driver";

export interface FactoryOptions {
  crewSize?: number;
  tickMs?: number;
  log?: (line: string) => void;
  /** Most turns one agent run may take. Default CRANE_MAX_TURNS, or 200. 0 for no limit. */
  maxTurns?: number;
  /** Most minutes a task may hold a crew slot. Default CRANE_TIME_LIMIT_MIN, or 90. 0 for no limit. */
  timeLimitMin?: number;
  /** How long to wait before retrying a transient failure, before jitter. Default CRANE_RETRY_DELAY_SEC, or 60s. */
  retryDelayMs?: number;
}

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
  return store.getSetting(DRIVER_KEY) ?? "unknown";
}

/**
 * The factory floor. Keeps a crew of agents busy: each idle agent claims the
 * oldest queued task, works it through the driver, and files the result.
 * State lives in the store, so the CLI and UI can steer it from anywhere.
 */
export class Factory {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, AbortController>(); // taskId -> abort
  private busy = new Set<string>(); // agentIds
  private mergingRepos = new Set<string>(); // repoIds with a merge in progress
  private crew: { id: string; name: string }[];
  private tickMs: number;
  private log: (line: string) => void;
  readonly maxTurns: number;
  readonly timeLimitMin: number;
  private retryDelayMs: number;

  constructor(
    private store: Store,
    private driver: AgentDriver,
    opts: FactoryOptions = {},
  ) {
    const size = Math.max(1, Math.min(CREW.length, opts.crewSize ?? Number(process.env.CRANE_AGENTS ?? 2)));
    this.crew = CREW.slice(0, size).map((name) => ({ id: `a-${name.toLowerCase()}`, name }));
    this.tickMs = opts.tickMs ?? 1000;
    this.log = opts.log ?? (() => {});
    this.maxTurns = Math.max(0, opts.maxTurns ?? envNumber("CRANE_MAX_TURNS") ?? DEFAULT_MAX_TURNS);
    this.timeLimitMin = Math.max(0, opts.timeLimitMin ?? envNumber("CRANE_TIME_LIMIT_MIN") ?? DEFAULT_TIME_LIMIT_MIN);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? (envNumber("CRANE_RETRY_DELAY_SEC") ?? 60) * 1000);
  }

  /**
   * Run the agent, giving a transient failure (overload, rate limit, network)
   * one more try after a pause. The retry resumes the same session when there
   * is one, so the agent picks up where it stopped instead of starting over.
   */
  private async runAgent(ctx: Omit<RunContext, "allowedTools" | "maxTurns">): Promise<RunResult> {
    const full: RunContext = {
      ...ctx,
      allowedTools: ctx.repo ? this.store.repoTools(ctx.repo.id).allowed : [],
      maxTurns: this.maxTurns || undefined,
    };
    try {
      return await this.driver.run(full);
    } catch (err) {
      if (ctx.signal.aborted || !(err instanceof AgentRunError) || !err.transient) throw err;
      // Jitter, so a crew that all hit the same overload doesn't come back at once.
      const wait = Math.round(this.retryDelayMs * (0.8 + Math.random() * 0.4));
      const reason = err.message.split("\n")[0]!.slice(0, 200).replace(/\.$/, "");
      ctx.emit("note", `${reason}. Trying once more in ${Math.max(1, Math.round(wait / 1000))}s`, { retry: true });
      await sleep(wait, ctx.signal);
      try {
        const r = await this.driver.run({ ...full, resume: err.sessionId ?? undefined });
        return { ...r, costUsd: r.costUsd + err.costUsd };
      } catch (again) {
        // Keep what the first attempt cost on whatever the second one throws.
        if (again instanceof AgentRunError) throw new AgentRunError(again.message, { ...again.opts, costUsd: again.costUsd + err.costUsd });
        throw again;
      }
    }
  }

  start() {
    for (const a of this.crew) {
      this.store.upsertAgent({ ...a, driver: this.driver.name });
      this.store.setAgentState(a.id, "idle", null);
    }
    this.store.pruneAgents(this.crew.map((a) => a.id));
    this.store.setSetting(DRIVER_KEY, this.driver.name);

    // A previous factory may have died mid-task. Put its work back in the queue.
    for (const m of this.store.listTasks({ status: ["running"] })) {
      this.store.updateTask(m.id, { status: "queued", agentId: null });
      this.store.addEvent(m.id, "status", "Re-queued after the factory restarted", { status: "queued" });
    }
    // Merges are safe to run again from the top, so just release them.
    for (const m of this.store.listTasks({ status: ["merging"] })) {
      if (m.agentId) this.store.updateTask(m.id, { agentId: null });
    }

    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ac of this.running.values()) ac.abort();
    this.store.setSetting(HEARTBEAT_KEY, "0");
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
      if (paused) continue;
      // Approved merges first: the operator has already said yes and is waiting on them.
      const merge = this.store.claimNextMerge(agent.id, [...this.mergingRepos]);
      if (merge) {
        this.busy.add(agent.id);
        this.merge(agent, merge).finally(() => this.busy.delete(agent.id));
        continue;
      }
      const task = this.store.claimNextTask(agent.id);
      if (!task) continue;
      this.busy.add(agent.id);
      this.work(agent, task).finally(() => this.busy.delete(agent.id));
    }
  }

  /** Land an approved task on its repo's default branch, with an agent on hand for conflicts. */
  private async merge(agent: { id: string; name: string }, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
    if (repo) this.mergingRepos.add(repo.id);
    this.store.setAgentState(agent.id, "working", task.id);
    this.log(`${agent.name} is merging ${task.id} · ${task.title}`);
    const emit = (type: Parameters<Store["addEvent"]>[1], message: string, data?: Record<string, unknown>) =>
      this.store.addEvent(task.id, type, message, data ?? null);
    let spent = 0;
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
        resolveConflicts: async ({ cwd, base, files }) => {
          try {
            const note = await installDependencies(cwd, { from: repo.path, signal: ac.signal });
            if (note) emit("note", note);
          } catch {
            // Not fatal: resolving conflicts rarely needs a build.
          }
          const r = await this.runAgent({
            task: this.store.getTask(task.id)!,
            repo,
            cwd,
            signal: ac.signal,
            emit,
            job: { kind: "resolve_conflicts", base, files },
          });
          spent += r.costUsd;
          for (const f of r.report.findings) emit("finding", f.title, { impact: f.impact, effort: f.effort });
        },
      });

      const main = repo.defaultBranch;
      const where = result.pushedTo ? ` and pushed to ${result.pushedTo}` : "";
      const message = result.checkoutBehind
        ? `Merged into ${main}${where}. Your checkout at ${result.checkoutBehind} has local changes, so it wasn't updated`
        : `Merged into ${main}${where}`;
      this.store.updateTask(task.id, { worktree: null, costUsd: (this.store.getTask(task.id)?.costUsd ?? 0) + spent });
      spent = 0;
      // Record the outcome before cleaning up: if the merge just updated Crane's own
      // checkout, a dev server may restart any moment.
      this.store.setStatus(task.id, "merged", message, {
        merge: { commit: result.commit, pushedTo: result.pushedTo, checkoutBehind: result.checkoutBehind },
      });
      this.log(`${agent.name} merged ${task.id}`);
      await removeWorktree(repo, workdir);
      if (!result.checkoutBehind) await deleteMergedBranch(repo, task.branch);
    } catch (err) {
      if (err instanceof AgentRunError) spent += err.costUsd;
      if (spent) this.store.updateTask(task.id, { costUsd: (this.store.getTask(task.id)?.costUsd ?? 0) + spent });
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

  private async work(agent: { id: string; name: string }, task: Task) {
    const ac = new AbortController();
    const limit = timeLimit(ac, this.timeLimitMin);
    this.running.set(task.id, ac);
    this.store.setAgentState(agent.id, "working", task.id);
    this.log(`${agent.name} picked up ${task.id} · ${task.title}`);
    const emit = (type: Parameters<Store["addEvent"]>[1], message: string, data?: Record<string, unknown>) =>
      this.store.addEvent(task.id, type, message, data ?? null);

    try {
      const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
      if (!repo) throw new Error("This task has no repo to work in");

      let cwd = repo.path;
      if (task.autonomy !== "observe") {
        const wt = await createWorktree(repo, task);
        cwd = wt.path;
        this.store.updateTask(task.id, { branch: wt.branch, worktree: wt.path });
        emit("note", `Working on branch ${wt.branch}`, { branch: wt.branch });
        try {
          const note = await installDependencies(wt.path, { from: repo.path, signal: ac.signal });
          if (note) emit("note", note);
        } catch (err) {
          if (ac.signal.aborted) throw err;
          // Not fatal: the agent can still read code and may be able to install itself.
          emit("note", `Couldn't install dependencies: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      const result = await this.runAgent({
        task: this.store.getTask(task.id)!,
        repo,
        cwd,
        signal: ac.signal,
        emit,
      });

      if (task.autonomy !== "observe") {
        const changed = await finalizeWorktree(repo, task, cwd);
        result.report.changedFiles = [...new Set([...changed, ...result.report.changedFiles])];
      }
      const logged = new Set(this.store.listEvents(task.id).filter((e) => e.type === "finding").map((e) => e.message));
      for (const f of result.report.findings) {
        if (!logged.has(f.title)) emit("finding", f.title, { impact: f.impact, effort: f.effort });
      }

      this.store.updateTask(task.id, { report: result.report, costUsd: result.costUsd });

      // Hold for the operator whenever there's something for them to decide.
      const needsOperator =
        task.autonomy === "propose" || (task.autonomy === "observe" && result.report.findings.length > 0);
      if (this.store.getTask(task.id)?.status === "cancelled") return;
      this.store.setStatus(task.id, needsOperator ? "needs_review" : "done", needsOperator ? "Ready for your review" : "Done");
      this.store.bumpAgentCompleted(agent.id);
      this.log(`${agent.name} finished ${task.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed run still cost something; count it.
      if (err instanceof AgentRunError && err.costUsd) this.store.updateTask(task.id, { costUsd: err.costUsd });
      const status = this.store.getTask(task.id)?.status;
      if (limit.hit() && status !== "cancelled") {
        const why = `Stopped after ${minutes(this.timeLimitMin)}, the most a task may run. Raise it with crane serve --time-limit or CRANE_TIME_LIMIT_MIN`;
        emit("error", why, { limit: "time" });
        this.store.setStatus(task.id, "failed", "Hit the time limit");
        this.log(`${agent.name} stopped ${task.id} at the time limit`);
      } else if (ac.signal.aborted || status === "cancelled") {
        if (status !== "cancelled") this.store.setStatus(task.id, "cancelled", "Cancelled");
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
