import type { Store } from "../core/store.js";
import type { Task } from "../core/types.js";
import type { AgentDriver } from "../agents/driver.js";
import { createWorktree, finalizeWorktree } from "./git.js";

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
      const task = this.store.claimNextTask(agent.id);
      if (!task) continue;
      this.busy.add(agent.id);
      this.work(agent, task).finally(() => this.busy.delete(agent.id));
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
