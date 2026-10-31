import { resolve } from "node:path";
import type { Store } from "../core/store.js";
import { DRIVER_NAMES, driverLabel, isDriverName, type Task, type NewTask, type Repo, type DriverInfo } from "../core/types.js";
import { currentBranch, isGitRepo, removeWorktree, repoRoot } from "./git.js";
import { DEFAULT_DRIVER_KEY, driverCatalog, isAvailable, sharedDrivers } from "./drivers.js";
import { factoryRoot } from "../core/paths.js";

/** An agent name the operator typed or sent, checked. Null and "default" mean the factory's default. */
function checkDriver(name: string | null | undefined): Task["driver"] {
  if (name === undefined || name === null || name === "" || name === "default") return null;
  if (!isDriverName(name)) throw new Error(`Unknown agent “${name}”. Use one of: ${DRIVER_NAMES.join(", ")}`);
  return name;
}

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
    const task = this.store.createTask({ ...input, driver: checkDriver(input.driver) });
    // Remembered so the next instruction that doesn't name a repo defaults to this one.
    if (task.repoId) this.store.setSetting("last_repo", task.repoId);
    return task;
  }

  private need(id: string): Task {
    const m = this.store.getTask(id);
    if (!m) throw new Error(`No task ${id}`);
    return m;
  }

  /**
   * Approve a task. When it changed code, this also merges its branch into the
   * repo's default branch and pushes it, unless `merge: false` ("Approve only").
   */
  async approve(id: string, note?: string, opts: { merge?: boolean } = {}): Promise<Task> {
    const m = this.need(id);
    if (m.status !== "needs_review") throw new Error(`Task ${m.id} isn't waiting for review`);
    const merge = (opts.merge ?? true) && !!m.branch;
    this.store.addEvent(m.id, "operator", note ? `Approved: ${note}` : "Approved");
    if (merge) return this.queueMerge(m);
    await this.cleanupWorktree(m, false);
    this.store.setStatus(m.id, "approved", m.branch ? `Approved. Branch ${m.branch} is kept for you to merge` : "Approved");
    return this.need(id);
  }

  /** Merge a task's branch into the default branch and push it. For tasks already approved or done. */
  async merge(id: string): Promise<Task> {
    const m = this.need(id);
    if (m.status === "needs_review") return this.approve(id);
    if (!m.branch) throw new Error(`Task ${m.id} didn't change any code, so there's nothing to merge`);
    if (!["approved", "done"].includes(m.status)) throw new Error(`Task ${m.id} isn't ready to merge`);
    this.store.addEvent(m.id, "operator", "Asked to merge");
    return this.queueMerge(m);
  }

  /** Hand the task to the factory, which merges it with the next free agent. */
  private queueMerge(m: Task): Task {
    const repo = m.repoId ? this.store.getRepo(m.repoId) : null;
    if (!repo) throw new Error(`Task ${m.id} has no repo to merge into`);
    this.store.updateTask(m.id, { agentId: null });
    this.store.setStatus(m.id, "merging", `Waiting to merge into ${repo.defaultBranch}`);
    return this.need(m.id);
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

  /**
   * Run a task again as a new one. It keeps the agent the operator chose for
   * it, unless `driver` names another (null or "default" for the factory's default).
   */
  retry(id: string, opts: { driver?: string | null } = {}): Task {
    const m = this.need(id);
    const driver = opts.driver === undefined ? m.driver : checkDriver(opts.driver);
    const next = this.store.createTask({ kind: m.kind, title: m.title, brief: m.brief, repoId: m.repoId, autonomy: m.autonomy, driver });
    const on = opts.driver !== undefined ? ` on ${driver ? driverLabel(driver) : "the default agent"}` : "";
    this.store.addEvent(m.id, "operator", `Retried as ${next.id}${on}`, { taskId: next.id });
    return next;
  }

  /** Every agent Crane can run, whether it's installed, and which is the default. */
  drivers(): Promise<DriverInfo[]> {
    return driverCatalog(this.store.getSetting(DEFAULT_DRIVER_KEY));
  }

  /** Choose the agent new tasks run on, unless the operator picks another for a task. */
  async setDefaultDriver(name: string): Promise<DriverInfo[]> {
    const driver = checkDriver(name);
    if (!driver) throw new Error("Choose which agent to use by default");
    const d = sharedDrivers().find((x) => x.name === driver)!;
    if (!(await isAvailable(d, 0))) {
      throw new Error(`${driverLabel(driver)} isn't installed here, so it can't be the default yet`);
    }
    this.store.setSetting(DEFAULT_DRIVER_KEY, driver);
    return this.drivers();
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
      driver: m.driver,
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
