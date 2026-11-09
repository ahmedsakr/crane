import { readdirSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, type Repo, type Task, type TaskStatus } from "@crane/contracts";
import type { Store } from "../core/store.js";
import { worktreesDir } from "@crane/backend-runtime";
import { putAwayWorktree } from "./git.js";

/**
 * Tasks whose worktree nothing will use again: a retry is a new task with its
 * own. Approved and done tasks keep theirs, since the operator may still merge.
 */
const PUT_AWAY_STATUSES: TaskStatus[] = ["merged", "rejected", "failed", "cancelled"];
/** Statuses where the agent may have left work uncommitted, which goes to the branch first. */
const SAVE_WORK_STATUSES: TaskStatus[] = ["failed", "cancelled"];
/** How often to look for worktrees to put away, besides right after a task stops. */
const SWEEP_MS = 60_000;

export interface WorktreeSweeperDeps {
  store: Store;
  log: (line: string) => void;
  /** Whether an agent or a merge is using this task's worktree right now. */
  inUse: (taskId: string) => boolean;
  /** Whether the factory is winding down, which ends a sweep between worktrees. */
  stopping: () => boolean;
}

/** Puts away the worktrees of tasks that are over, one sweep at a time. */
export class WorktreeSweeper {
  private sweeping: Promise<void> | null = null;
  private lastSweep = 0;
  /** Worktrees left in place this run, so each is reported once rather than every sweep. */
  private keptWorktrees = new Set<string>();

  constructor(private deps: WorktreeSweeperDeps) {}

  /** The sweep under way, if any, so stopping can wait for it. */
  get inProgress(): Promise<void> | null {
    return this.sweeping;
  }

  /** A task stopped. If its worktree is finished with, it goes on the next sweep rather than a minute later. */
  taskEnded(status: TaskStatus | undefined) {
    if (status && PUT_AWAY_STATUSES.includes(status)) this.lastSweep = 0;
  }

  /** Start a sweep for worktrees nothing needs any more, unless one ran lately or is under way. */
  sweep() {
    if (this.sweeping || this.deps.stopping() || Date.now() - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = Date.now();
    this.sweeping = this.putAwayWorktrees()
      .catch((err) => this.deps.log(`Couldn't clean up worktrees: ${errorMessage(err)}`))
      .finally(() => {
        this.sweeping = null;
      });
  }

  /**
   * Remove the worktrees of tasks that are over: merged, declined, failed, or
   * cancelled. Work a failed or cancelled task left uncommitted is committed to
   * its branch first, so the branch still has it. Also finds directories left
   * after a crash, whose task no longer records them.
   */
  private async putAwayWorktrees() {
    const { store, inUse, stopping } = this.deps;
    for (const [id, path] of this.findWorktrees()) {
      if (stopping()) return;
      if (inUse(id) || this.keptWorktrees.has(path)) continue;
      // Read it fresh: the operator may have acted on it since the sweep started.
      const task = store.getTask(id);
      if (!task || task.id !== id || !PUT_AWAY_STATUSES.includes(task.status)) continue;
      const repo = task.repoId ? store.getRepo(task.repoId) : null;
      if (!repo) continue;
      await this.putAway(repo, task, path);
    }
  }

  /** Worktrees to consider, as taskId -> path: those tasks record, and any other directory on disk. */
  private findWorktrees() {
    const found = new Map<string, string>();
    for (const t of this.deps.store.tasksWithWorktrees(PUT_AWAY_STATUSES)) found.set(t.id, t.worktree!);
    const dir = worktreesDir();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !found.has(entry.name)) found.set(entry.name, join(dir, entry.name));
    }
    return found;
  }

  private async putAway(repo: Repo, task: Task, path: string) {
    const { store, log } = this.deps;
    let result;
    try {
      result = await putAwayWorktree(repo, task, path, { saveWork: SAVE_WORK_STATUSES.includes(task.status) });
    } catch (err) {
      result = { removed: false as const, reason: errorMessage(err).split("\n")[0]! };
    }
    if (!result.removed) {
      this.keptWorktrees.add(path);
      log(`Left the worktree of ${task.id} at ${path}: ${result.reason}`);
      return;
    }
    if (task.worktree) store.updateTask(task.id, { worktree: null });
    if (result.saved) {
      store.addEvent(task.id, "note", `Saved its unfinished work to ${task.branch} and removed its worktree`, {
        branch: task.branch,
      });
    }
  }
}
