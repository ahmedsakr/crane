import { resolve } from "node:path";
import type { Store } from "../core/store.js";
import {
  DRIVER_NAMES,
  driverLabel,
  isDriverName,
  type Task,
  type NewTask,
  type Repo,
  type RepoTools,
  type DriverInfo,
} from "../core/types.js";
import { currentBranch, isGitRepo, removeWorktree, repoRoot } from "./git.js";
import { DEFAULT_DRIVER_KEY, driverCatalog, isAvailable, sharedDrivers } from "./drivers.js";
import { factoryRoot } from "../core/paths.js";
import { overlapsDenied, parseRule, ruleLabel } from "../core/permissions.js";
import { ALWAYS_DENIED } from "../agents/claude-code.js";

/**
 * Accept what an operator would type: a rule (`Bash(npm ci:*)`, `WebFetch`)
 * or just a command (`npm ci`), which allows that command and its arguments.
 */
export function toRule(input: string): string {
  const s = input.trim().replace(/^`|`$/g, "");
  if (/^(mcp__[\w-]+|[A-Z][\w-]*)(\(.+\))?$/.test(s)) return s;
  return `Bash(${s.replace(/:\*$/, "")}:*)`;
}

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

  /** Preferences apply to the next assignment; current work finishes normally. */
  async configureCrew(id: string, input: { active?: boolean; defaultDriver?: string | null }) {
    if (!this.store.listAgents().some((a) => a.id === id)) throw new Error(`No crew member ${id}`);
    if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("Active must be a boolean");
    const driver = checkDriver(input.defaultDriver);
    if (driver) {
      const d = sharedDrivers().find((d) => d.name === driver)!;
      if (!(await isAvailable(d))) throw new Error(`${driverLabel(driver)} isn't installed here`);
    }
    if (input.defaultDriver !== undefined) this.store.setSetting(`crew_driver_${id}`, driver ?? "");
    if (input.active !== undefined) this.store.setSetting(`crew_active_${id}`, String(input.active));
    return this.store.listAgents().find((a) => a.id === id)!;
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

  private needRepo(idOrName: string): Repo {
    const r = this.store.getRepo(idOrName);
    if (!r) throw new Error(`No repo ${idOrName}`);
    return r;
  }

  /**
   * Let every agent working in this repo use a tool or command from now on.
   * Crane's deny list still wins, so this can never allow pushing or merging.
   * `taskId` notes the decision on the task that prompted it.
   */
  allowTool(repoId: string, input: string, taskId?: string): RepoTools {
    const repo = this.needRepo(repoId);
    const rule = toRule(input);
    const parsed = parseRule(rule);
    if (!parsed) throw new Error(`“${input}” isn't a command or tool Crane can allow`);
    if (parsed.tool === "Bash" && (!parsed.pattern || /^[:*\s]*$/.test(parsed.pattern))) {
      throw new Error("Allowing every command would let agents run anything. Allow one command at a time");
    }
    if (overlapsDenied(rule, ALWAYS_DENIED)) {
      throw new Error(`Agents are never allowed to run ${ruleLabel(rule)}. Crane does that itself, and only when you approve`);
    }
    const tools = this.store.repoTools(repo.id);
    const next = {
      allowed: [...tools.allowed.filter((r) => r !== rule), rule],
      keptBlocked: tools.keptBlocked.filter((r) => r !== rule),
    };
    this.store.setRepoTools(repo.id, next);
    this.noteOnTask(taskId, `Allowed ${ruleLabel(rule)} for ${repo.name}`, { rule, repoId: repo.id });
    return next;
  }

  /** Stop suggesting this blocked command for the repo. It stays blocked, as it already was. */
  keepBlocked(repoId: string, input: string, taskId?: string): RepoTools {
    const repo = this.needRepo(repoId);
    const rule = toRule(input);
    const tools = this.store.repoTools(repo.id);
    const next = {
      allowed: tools.allowed.filter((r) => r !== rule),
      keptBlocked: [...tools.keptBlocked.filter((r) => r !== rule), rule],
    };
    this.store.setRepoTools(repo.id, next);
    this.noteOnTask(taskId, `Kept ${ruleLabel(rule)} blocked for ${repo.name}`, { rule, repoId: repo.id });
    return next;
  }

  /** Take back an allowed command. Agents will be blocked from it again, and Crane may ask about it again. */
  disallowTool(repoId: string, input: string): RepoTools {
    const repo = this.needRepo(repoId);
    const rule = toRule(input);
    const tools = this.store.repoTools(repo.id);
    if (!tools.allowed.includes(rule)) throw new Error(`${ruleLabel(rule)} isn't allowed for ${repo.name}`);
    const next = { ...tools, allowed: tools.allowed.filter((r) => r !== rule) };
    this.store.setRepoTools(repo.id, next);
    return next;
  }

  private noteOnTask(taskId: string | undefined, message: string, data: Record<string, unknown>) {
    const t = taskId ? this.store.getTask(taskId) : null;
    if (t) this.store.addEvent(t.id, "operator", message, data);
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
