import { resolve } from "node:path";
import { crewSettingKey, type Store } from "../core/store.js";
import {
  DRIVER_NAMES,
  EFFORT_LEVELS,
  driverLabel,
  ruleLabel,
  isDriverName,
  isMaintenanceRole,
  isTunable,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  type MaintenanceRole,
  type Task,
  type NewTask,
  type Repo,
  type RepoTools,
  type DriverInfo,
  type DriverName,
  type DriverSettings,
  type TaskRunOptions,
  type PostmortemSettings,
} from "@crane/contracts";
import { inferDefaultBranch, isGitRepo, removeWorktree, repoRoot } from "./git.js";
import { DEFAULT_DRIVER_KEY, driverCatalog, driverEffortKey, driverModelKey, isAvailable, sharedDrivers } from "./drivers.js";
import { factoryRoot } from "../core/paths.js";
import { parseRule } from "@crane/contracts/rules";
import { overlapsDenied } from "../core/permissions.js";
import { ALWAYS_DENIED } from "../agents/policy.js";

/**
 * Accept what an operator would type: a rule (`Bash(npm ci:*)`, `WebFetch`)
 * or just a command (`npm ci`), which allows that command and its arguments.
 */
export function toRule(input: string): string {
  const s = input.trim().replace(/^`|`$/g, "");
  if (/^(mcp__[\w-]+|[A-Z][\w-]*)(\(.+\))?$/.test(s)) return s;
  return `Bash(${s.replace(/:\*$/, "")}:*)`;
}

/** What model names look like: `opus`, `claude-opus-5-5[1m]`, `gpt-5-codex`, `us.anthropic.claude-…:0`. */
const MODEL_NAME = /^[A-Za-z0-9][\w.:/@[\]-]{0,119}$/;

/** An agent name the operator typed or sent, checked. Null and "default" mean the factory's default. */
function checkDriver(name: string | null | undefined): DriverName | null {
  if (name === undefined || name === null || name === "" || name === "default") return null;
  if (!isDriverName(name)) throw new Error(`Unknown agent “${name}”. Use one of: ${DRIVER_NAMES.join(", ")}`);
  return name;
}

/** A maintenance role the operator typed or sent, checked. Null, "" and "none" clear it. */
function checkRole(name: string | null | undefined): MaintenanceRole | null {
  if (name === undefined || name === null || name === "" || name === "none") return null;
  const key = name.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!isMaintenanceRole(key)) throw new Error(`Unknown maintenance role “${name}”. Use one of: ${MAINTENANCE_ROLES.join(", ")}, or none`);
  return key;
}

/** Null, blank text and "default" clear a driver setting. */
function normalizeDriverSetting(value: string | null): string {
  const text = value?.trim() ?? "";
  return text === "default" ? "" : text;
}

/** Shared validation for saved preferences and task overrides, before any writes. */
function checkDriverSettings(driver: DriverName, input: Partial<DriverSettings>): Partial<DriverSettings> {
  if (!isTunable(driver)) throw new Error(`${driverLabel(driver)} doesn't call a model, so there's no model or effort to set`);
  const settings: Partial<DriverSettings> = {};
  if (input.model !== undefined) {
    if (input.model !== null && typeof input.model !== "string") throw new Error("Model must be text");
    const model = normalizeDriverSetting(input.model);
    if (model && !MODEL_NAME.test(model)) throw new Error(`“${model}” doesn't look like a model name`);
    settings.model = model || null;
  }
  if (input.effort !== undefined) {
    if (input.effort !== null && typeof input.effort !== "string") throw new Error("Effort must be text");
    const effort = normalizeDriverSetting(input.effort).toLowerCase();
    const levels = EFFORT_LEVELS[driver];
    if (effort && !levels.includes(effort)) {
      throw new Error(`${driverLabel(driver)} takes effort ${levels.join(", ")}, or default`);
    }
    settings.effort = effort || null;
  }
  return settings;
}

function checkTaskRunOptions(input: TaskRunOptions): TaskRunOptions {
  const driver = checkDriver(input.driver);
  // Untuned tasks may follow the default agent, which can change before pickup.
  if (input.model == null && input.effort == null) return { driver, model: null, effort: null };
  if (!driver) throw new Error("Choose an agent before setting a task's model or effort");
  return { driver, ...checkDriverSettings(driver, input) };
}

/**
 * Everything an operator can do, shared by the web UI and the CLI so both
 * behave identically. Task decisions record an `operator` event on the task.
 */
export class OperatorActions {
  constructor(private store: Store) {}

  /** Make sure Crane's own checkout is registered, so factory tasks have somewhere to work. */
  async ensureFactoryRepo(): Promise<Repo | null> {
    const existing = this.store.listRepos().find((r) => r.isFactory);
    if (existing) return existing;
    const root = factoryRoot();
    if (!(await isGitRepo(root))) return null;
    return this.store.addRepo({ path: await repoRoot(root), name: "crane", defaultBranch: await inferDefaultBranch(root), isFactory: true });
  }

  async connectRepo(path: string, name?: string): Promise<Repo> {
    const abs = resolve(path);
    if (!(await isGitRepo(abs))) throw new Error(`${abs} is not a git repository`);
    const root = await repoRoot(abs);
    return this.store.addRepo({ path: root, name, defaultBranch: await inferDefaultBranch(root) });
  }

  createTask(input: NewTask): Task {
    if (input.kind !== "factory_feature" && !input.repoId) throw new Error("Choose a repo for this task");
    if (input.kind === "factory_feature" && !input.repoId) {
      input.repoId = this.store.listRepos().find((r) => r.isFactory)?.id ?? null;
    }
    if (!input.title.trim()) throw new Error("Give the task a title");
    // Nobody else claims an assigned task, so it must name someone on the crew.
    if (input.assignee && !this.store.listAgents().some((a) => a.id === input.assignee)) {
      throw new Error(`No crew member ${input.assignee}`);
    }
    const task = this.store.createTask({ ...input, ...checkTaskRunOptions(input), assignee: input.assignee || null, driverSettings: null });
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
    if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
    if (opts.merge !== undefined && typeof opts.merge !== "boolean") throw new Error("Merge must be a boolean");
    const merge = (opts.merge ?? true) && !!m.branch;
    this.store.addEvent(m.id, "operator", note ? `Approved: ${note}` : "Approved");
    if (merge) return this.queueMerge(m);
    await this.cleanupWorktree(m, false);
    this.store.setStatus(m.id, "approved", m.branch ? `Approved. Branch ${m.branch} is kept for you to merge` : "Approved");
    return this.need(id);
  }

  /**
   * Approve a queued or running task ahead of time. When its run finishes and
   * its checks pass, it goes straight to the merge queue instead of waiting for
   * review. A failed run or check fails the task as usual, and a merge that
   * can't land comes back for review. `undoPreApproval` takes it back.
   */
  preApprove(id: string, note?: string): Task {
    const m = this.need(id);
    if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
    if (m.autonomy === "observe") throw new Error(`Task ${m.id} is investigate-only, so it has nothing to merge`);
    if (m.status === "needs_review") throw new Error(`Task ${m.id} is already waiting for review. Approve it instead`);
    if (m.preApprovedAt) throw new Error(`Task ${m.id} is already pre-approved`);
    if (!this.store.setPreApproval(m.id, true)) throw new Error(`Task ${m.id} isn't queued or running, so it can't be pre-approved`);
    this.store.addEvent(m.id, "operator", note ? `Pre-approved: ${note}` : "Pre-approved", { preApproved: true });
    return this.need(id);
  }

  /** Take back a pre-approval, so the task waits for review when it finishes. */
  undoPreApproval(id: string): Task {
    const m = this.need(id);
    if (!m.preApprovedAt) throw new Error(`Task ${m.id} isn't pre-approved`);
    if (!this.store.setPreApproval(m.id, false)) {
      throw new Error(`Task ${m.id} has already finished its run, so its pre-approval can't be undone`);
    }
    this.store.addEvent(m.id, "operator", "Undid pre-approval. It waits for your review", { preApproved: false });
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
    if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
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
    // A maintenance run goes back to the member it was started for.
    const next = this.store.createTask({ kind: m.kind, title: m.title, brief: m.brief, repoId: m.repoId, autonomy: m.autonomy,
      driver, model: driver === m.driver ? m.model : null, effort: driver === m.driver ? m.effort : null, assignee: m.assignee,
      driverSettings: driver === m.driver ? m.driverSettings : null });
    const on = opts.driver !== undefined ? ` on ${driver ? driverLabel(driver) : "the default agent"}` : "";
    this.store.addEvent(m.id, "operator", `Retried as ${next.id}${on}`, { taskId: next.id });
    return next;
  }

  /** Every agent Crane can run, whether it's installed, and which is the default. */
  drivers(): Promise<DriverInfo[]> {
    return driverCatalog(this.store.getSetting(DEFAULT_DRIVER_KEY), sharedDrivers(), (k) => this.store.getSetting(k));
  }

  /**
   * Choose the model and effort one agent runs with. Leave a field out to keep
   * it; null, "" or "default" goes back to the agent's own default. It applies
   * from the next run, including a resumed one.
   */
  async configureDriver(name: string, input: { model?: string | null; effort?: string | null }): Promise<DriverInfo[]> {
    const driver = checkDriver(name);
    if (!driver) throw new Error("Choose which agent to set up");
    const { model, effort } = checkDriverSettings(driver, input);
    // Validate the whole request before changing either saved preference.
    if (model !== undefined) this.store.setSetting(driverModelKey(driver), model ?? "");
    if (effort !== undefined) this.store.setSetting(driverEffortKey(driver), effort ?? "");
    return this.drivers();
  }

  postmortemSettings(): PostmortemSettings {
    return this.store.postmortemSettings();
  }

  /** Defaults are captured when a merge queues its read-only post-mortem. */
  configurePostmortem(input: { driver?: string | null; model?: string | null; effort?: string | null }): PostmortemSettings {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected post-mortem settings");
    const saved = this.postmortemSettings();
    const driver = input.driver === undefined ? saved.driver : checkDriver(input.driver);
    const changed = driver !== saved.driver;
    const next = { driver, model: changed ? null : saved.model, effort: changed ? null : saved.effort };
    if (driver && isTunable(driver)) {
      const tuning = checkDriverSettings(driver, input);
      if (tuning.model !== undefined) next.model = tuning.model || null;
      if (tuning.effort !== undefined) next.effort = tuning.effort || null;
    } else {
      for (const value of [input.model, input.effort]) {
        if (value !== undefined && value !== null && (typeof value !== "string" || normalizeDriverSetting(value))) {
          throw new Error("Choose an agent that calls a model before setting post-mortem model or effort");
        }
      }
      next.model = next.effort = null;
    }
    this.store.setPostmortemSettings(next);
    return next;
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

  /**
   * Preferences apply to the next assignment; current work finishes normally.
   * A `role` dedicates the member to one kind of maintenance (null makes it a
   * general member again): from then on it takes only the runs started for it.
   */
  async configureCrew(id: string, input: { active?: boolean; defaultDriver?: string | null; role?: string | null }) {
    if (!this.store.listAgents().some((a) => a.id === id)) throw new Error(`No crew member ${id}`);
    if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("Active must be a boolean");
    const role = checkRole(input.role);
    const driver = checkDriver(input.defaultDriver);
    if (driver) {
      const d = sharedDrivers().find((d) => d.name === driver)!;
      if (!(await isAvailable(d))) throw new Error(`${driverLabel(driver)} isn't installed here`);
    }
    if (input.defaultDriver !== undefined) this.store.setSetting(crewSettingKey.defaultDriver(id), driver ?? "");
    if (input.active !== undefined) this.store.setSetting(crewSettingKey.active(id), String(input.active));
    if (input.role !== undefined) this.store.setSetting(crewSettingKey.role(id), role ?? "");
    return this.store.listAgents().find((a) => a.id === id)!;
  }

  /**
   * Start a crew member's maintenance run on Crane's own repo. The task is
   * assigned to that member, so only they pick it up, at their role's freedom.
   */
  async runRole(id: string): Promise<Task> {
    const member = this.store.listAgents().find((a) => a.id === id);
    if (!member) throw new Error(`No crew member ${id}`);
    if (!member.role) throw new Error(`${member.name} has no maintenance role. Give them one first`);
    if (!member.active) throw new Error(`${member.name} is on-call. Activate them first, so the run doesn't wait in the queue`);
    const repo = await this.ensureFactoryRepo();
    if (!repo) throw new Error("Crane's own repo isn't connected, so there's nothing to maintain");
    const open = this.store
      .listTasks({ status: ["queued", "running"], repoId: repo.id })
      .find((t) => t.assignee === member.id);
    if (open) throw new Error(`${member.name} already has a run under way: ${open.id} · ${open.title}`);

    const role = MAINTENANCE_ROLE[member.role];
    const task = this.createTask({
      kind: "maintenance",
      title: `${role.action} in ${repo.name}`,
      brief: `${role.brief}\n\nStarted from ${member.name}'s maintenance role: ${role.label}.`,
      repoId: repo.id,
      autonomy: role.autonomy,
      assignee: member.id,
    });
    this.store.addEvent(task.id, "operator", `Started ${member.name}'s ${role.label.toLowerCase()} run`, {
      agentId: member.id,
      role: member.role,
    });
    return task;
  }

  /** Turn one finding from a report into its own task that is allowed to make the change. */
  followUp(id: string, findingIndex: number, opts: TaskRunOptions = {}): Task {
    const m = this.need(id);
    if (!Number.isInteger(findingIndex) || findingIndex < 0) throw new Error("Choose a finding by its number");
    const f = m.report?.findings[findingIndex];
    if (!f) throw new Error(`Task ${m.id} has no finding #${findingIndex + 1}`);
    const driver = opts.driver === undefined ? m.driver : checkDriver(opts.driver);
    const settings = checkTaskRunOptions({
      driver,
      model: opts.model === undefined ? (driver === m.driver ? m.model : null) : opts.model,
      effort: opts.effort === undefined ? (driver === m.driver ? m.effort : null) : opts.effort,
    });
    const next = this.store.createTask({
      kind: m.kind,
      title: f.title,
      brief: `${f.detail}\n\nFollow-up to task ${m.id}: “${m.title}”.`,
      repoId: m.repoId,
      autonomy: "propose",
      ...settings,
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
