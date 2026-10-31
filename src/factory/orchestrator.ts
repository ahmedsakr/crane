import type { Store } from "../core/store.js";
import type { Task } from "../core/types.js";
import type { AgentDriver } from "../agents/driver.js";
import { join } from "node:path";
import { createWorktree, finalizeWorktree, installDependencies, removeWorktree } from "./git.js";
import { deleteMergedBranch, landTask, MergeError } from "./merge.js";
import { worktreesDir } from "../core/paths.js";

const CREW = ["Jib", "Boom", "Hoist", "Trolley", "Rigger", "Winch", "Gantry", "Mast"];
const HEARTBEAT_KEY = "factory_heartbeat";
const DRIVER_KEY = "factory_driver";

export interface FactoryOptions {
  crewSize?: number;
  tickMs?: number;
  log?: (line: string) => void;
}

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

  constructor(
    private store: Store,
    private driver: AgentDriver,
    opts: FactoryOptions = {},
  ) {
    const size = Math.max(1, Math.min(CREW.length, opts.crewSize ?? Number(process.env.CRANE_AGENTS ?? 2)));
    this.crew = CREW.slice(0, size).map((name) => ({ id: `a-${name.toLowerCase()}`, name }));
    this.tickMs = opts.tickMs ?? 1000;
    this.log = opts.log ?? (() => {});
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
            const ran = await installDependencies(cwd, ac.signal);
            if (ran) emit("note", `Installed dependencies (${ran})`);
          } catch {
            // Not fatal: resolving conflicts rarely needs a build.
          }
          const r = await this.driver.run({
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
      if (spent) this.store.updateTask(task.id, { costUsd: (this.store.getTask(task.id)?.costUsd ?? 0) + spent });
      if (ac.signal.aborted) {
        // The factory is stopping. Leave it waiting; the next factory picks it up again.
        this.store.updateTask(task.id, { agentId: null });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      emit("error", message);
      this.store.setStatus(task.id, "needs_review", "Couldn't merge. Back with you", { merge: { error: message } });
      this.log(`${agent.name} couldn't merge ${task.id}: ${message}`);
    } finally {
      this.running.delete(`merge:${task.id}`);
      if (repo) this.mergingRepos.delete(repo.id);
      this.store.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }

  private async work(agent: { id: string; name: string }, task: Task) {
    const ac = new AbortController();
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
          const ran = await installDependencies(wt.path, ac.signal);
          if (ran) emit("note", `Installed dependencies (${ran})`);
        } catch (err) {
          if (ac.signal.aborted) throw err;
          // Not fatal: the agent can still read code and may be able to install itself.
          emit("note", `Couldn't install dependencies: ${(err as Error).message.split("\n")[0]}`);
        }
      }

      const result = await this.driver.run({
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
      if (ac.signal.aborted || this.store.getTask(task.id)?.status === "cancelled") {
        if (this.store.getTask(task.id)?.status !== "cancelled") this.store.setStatus(task.id, "cancelled", "Cancelled");
      } else {
        emit("error", message);
        this.store.setStatus(task.id, "failed", "Failed");
        this.log(`${agent.name} failed ${task.id}: ${message}`);
      }
    } finally {
      this.running.delete(task.id);
      this.store.setAgentState(agent.id, this.store.isPaused() ? "paused" : "idle", null);
    }
  }
}
