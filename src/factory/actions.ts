import { resolve } from "node:path";
import type { Store } from "../core/store.js";
import type { Task, NewTask, Repo } from "../core/types.js";
import { currentBranch, isGitRepo, removeWorktree, repoRoot } from "./git.js";
import { factoryRoot } from "../core/paths.js";

/**
 * Everything an operator can do, shared by the web UI and the CLI so both
 * behave identically. Each action records an `operator` event on the task.
 */
export class OperatorActions {
  constructor(private store: Store) {}

  /** Make sure Crane's own checkout is registered, so factory tasks have somewhere to work. */
  async ensureFactoryRepo(): Promise<Repo | null> {
    const existing = this.store.listRepos().find((r) => r.isFactory);
    if (existing) return existing;
    const root = factoryRoot();
    if (!(await isGitRepo(root))) return null;
    return this.store.addRepo({ path: await repoRoot(root), name: "crane", defaultBranch: await currentBranch(root), isFactory: true });
  }

  async connectRepo(path: string, name?: string): Promise<Repo> {
    const abs = resolve(path);
    if (!(await isGitRepo(abs))) throw new Error(`${abs} is not a git repository`);
    const root = await repoRoot(abs);
    return this.store.addRepo({ path: root, name, defaultBranch: await currentBranch(root) });
  }

  createTask(input: NewTask): Task {
    if (input.kind !== "factory_feature" && !input.repoId) throw new Error("Choose a repo for this task");
    if (input.kind === "factory_feature" && !input.repoId) {
      input.repoId = this.store.listRepos().find((r) => r.isFactory)?.id ?? null;
    }
    if (!input.title.trim()) throw new Error("Give the task a title");
    const task = this.store.createTask(input);
    // Remembered so the next instruction that doesn't name a repo defaults to this one.
    if (task.repoId) this.store.setSetting("last_repo", task.repoId);
    return task;
  }

  private need(id: string): Task {
    const m = this.store.getTask(id);
    if (!m) throw new Error(`No task ${id}`);
    return m;
  }

  async approve(id: string, note?: string): Promise<Task> {
    const m = this.need(id);
    if (m.status !== "needs_review") throw new Error(`Task ${m.id} isn't waiting for review`);
    this.store.addEvent(m.id, "operator", note ? `Approved: ${note}` : "Approved");
    await this.cleanupWorktree(m, false);
    this.store.setStatus(m.id, "approved", m.branch ? `Approved. Branch ${m.branch} is ready to merge` : "Approved");
    return this.need(id);
  }

  async reject(id: string, note?: string): Promise<Task> {
    const m = this.need(id);
    if (m.status !== "needs_review") throw new Error(`Task ${m.id} isn't waiting for review`);
    this.store.addEvent(m.id, "operator", note ? `Declined: ${note}` : "Declined");
    await this.cleanupWorktree(m, true);
    this.store.setStatus(m.id, "rejected", "Declined");
    return this.need(id);
  }

  cancel(id: string): Task {
    const m = this.need(id);
    if (!["queued", "running"].includes(m.status)) throw new Error(`Task ${m.id} isn't in progress`);
    this.store.addEvent(m.id, "operator", "Cancelled by operator");
    this.store.setStatus(m.id, "cancelled", "Cancelled");
    return this.need(id);
  }

  retry(id: string): Task {
    const m = this.need(id);
    const next = this.store.createTask({ kind: m.kind, title: m.title, brief: m.brief, repoId: m.repoId, autonomy: m.autonomy });
    this.store.addEvent(m.id, "operator", `Retried as ${next.id}`, { taskId: next.id });
    return next;
  }

  /** Turn one finding from a report into its own task that is allowed to make the change. */
  followUp(id: string, findingIndex: number): Task {
    const m = this.need(id);
    const f = m.report?.findings[findingIndex];
    if (!f) throw new Error(`Task ${m.id} has no finding #${findingIndex + 1}`);
    const next = this.store.createTask({
      kind: m.kind,
      title: f.title,
      brief: `${f.detail}\n\nFollow-up to task ${m.id}: “${m.title}”.`,
      repoId: m.repoId,
      autonomy: "propose",
    });
    this.store.addEvent(m.id, "operator", `Started follow-up ${next.id}: ${f.title}`, { taskId: next.id });
    return next;
  }

  pause() {
    this.store.setPaused(true);
  }

  resume() {
    this.store.setPaused(false);
  }

  private async cleanupWorktree(m: Task, deleteBranch: boolean) {
    if (!m.worktree || !m.repoId) return;
    const repo = this.store.getRepo(m.repoId);
    if (!repo) return;
    await removeWorktree(repo, m.worktree, deleteBranch && m.branch ? { deleteBranch: m.branch } : {});
    this.store.updateTask(m.id, { worktree: null, ...(deleteBranch ? { branch: null } : {}) });
  }
}
