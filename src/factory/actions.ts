import { resolve } from "node:path";
import { shortId } from "../core/ids.js";
import { goalResearchTask } from "./goals.js";
import { validateGoalPlan, type Goal, type NewGoal } from "@crane/contracts";
import { nextCrewFire, validateCrewSchedule, crewScheduleLabel, type CrewScheduleInput, type CrewSchedule } from "@crane/contracts";
import { crewSettingKey, type Store } from "../core/store.js";
import {
  AUTONOMY_LABEL,
  DRIVER_NAMES,
  EFFORT_LEVELS,
  KIND_LABEL,
  driverLabel,
  visualReviewPending,
  ruleLabel,
  isDriverName,
  isMaintenanceRole,
  isTunable,
  LOOKOUTS,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  type Lookout,
  type MaintenanceRole,
  type Task,
  type NewTask,
  type Repo,
  type RepoTools,
  type DriverInfo,
  type DriverName,
  type DriverSettings,
  type TaskRunOptions,
  type RoleRunOptions,
  type TaskGates,
  type PostmortemSettings,
  type RetentionSettings,
} from "@crane/contracts";
import { inferDefaultBranch, isGitRepo, removeWorktree, repoRoot } from "./git.js";
import { driverCatalog, isAvailable, sharedDrivers } from "./drivers.js";
import { DEFAULT_DRIVER_KEY, driverEffortKey, driverModelKey } from "./settings.js";
import { factoryRoot } from "../core/paths.js";
import { parseRule } from "@crane/contracts/rules";
import { ALWAYS_DENIED, overlapsDenied } from "@crane/agent-policy";
import { git } from "../core/git.js";

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

const MAX_GATES = 20;

/** Require an unambiguous future instant; save UTC so SQLite can compare timestamps. */
export function checkScheduledAt(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const match = typeof input === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input)
    : null;
  if (!match) throw new Error("Start time must be an ISO 8601 timestamp with a timezone, like 2030-06-15T09:00:00-04:00");
  const [, year, month, day, hour, minute, second] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const time = Date.parse(input as string);
  if (!Number.isFinite(time) || Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) {
    throw new Error("Start time must be a valid date and time");
  }
  if (time <= Date.now()) throw new Error("Choose a start time in the future");
  const utc = new Date(time).toISOString();
  if (utc.length !== 24) throw new Error("Start time must have a four-digit UTC year");
  return utc;
}

/** Acceptance criteria the operator gave, one per entry, trimmed. Blank entries are dropped. */
function checkAcceptance(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((c) => typeof c !== "string")) throw new Error("Acceptance criteria must be a list of text");
  const criteria = [...new Set(input.map((c: string) => c.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (criteria.length > MAX_GATES) throw new Error(`Give at most ${MAX_GATES} acceptance criteria`);
  if (criteria.some((c) => c.length > 500)) throw new Error("Keep each acceptance criterion under 500 characters");
  return criteria;
}

/**
 * What else the agent should look out for, by name. Takes `test-gaps` as well
 * as `test_gaps`, drops repeats, and keeps Crane's own order.
 */
export function checkLookouts(input: unknown): Lookout[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((l) => typeof l !== "string")) throw new Error("Lookouts must be a list of names");
  const given = new Set(input.map((l: string) => l.trim().toLowerCase().replace(/[-\s]+/g, "_")).filter(Boolean));
  const unknown = [...given].filter((l) => !(LOOKOUTS as readonly string[]).includes(l));
  if (unknown.length) throw new Error(`Crane can't look out for “${unknown[0]}”. Choose from ${LOOKOUTS.join(", ")}`);
  return LOOKOUTS.filter((l) => given.has(l));
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

  createGoal(input: NewGoal): Goal {
    if (typeof input.outcome !== "string" || !input.outcome.trim() || input.outcome.trim().length > 20000) throw new Error("Describe the desired outcome in 1 to 20000 characters");
    const repo = typeof input.repoId === "string" ? this.store.getRepo(input.repoId) : null;
    if (!repo) throw new Error("Choose a connected repo for this goal");
    const outcome = input.outcome.trim();
    const research = checkTaskRunOptions(input);
    return this.store.createGoal({ outcome, title: outcome.split("\n")[0]!.slice(0, 120), repoId: repo.id, research },
      goalResearchTask(this.store, repo, outcome, research));
  }

  reviseGoal(id: string, revision: unknown, feedback: unknown): Goal {
    const goal = this.store.getGoal(id);
    if (!goal) throw new Error(`No goal ${id}`);
    if (typeof feedback !== "string" || !feedback.trim() || feedback.trim().length > 20000) throw new Error("Give feedback in 1 to 20000 characters");
    const repo = this.store.getRepo(goal.repoId);
    if (!repo) throw new Error("The goal's repo is no longer connected");
    return this.store.reviseGoal(id, revision, feedback.trim(), goalResearchTask(this.store, repo, goal.outcome, goal.research, goal, feedback.trim()));
  }

  editGoalPlan(id: string, revision: unknown, input: unknown): Goal {
    return this.store.saveGoalPlan(id, revision, validateGoalPlan(input));
  }

  approveGoal(id: string, revision: unknown, autoMerge: unknown = false): Goal {
    if (typeof autoMerge !== "boolean") throw new Error("Automatic merging must be a boolean");
    return this.store.approveGoal(id, revision, autoMerge);
  }

  cancelGoal(id: string, revision: unknown): Goal {
    return this.store.cancelGoal(id, revision);
  }

  retryGoalTask(id: string, revision: unknown, taskId: string, opts: { driver?: string | null } = {}): Goal {
    return this.store.retryGoalTask(id, revision, taskId, () => {
      const next = this.retryTask(taskId, opts);
      if (this.store.getGoal(id)!.autoMerge) this.preApprove(next.id, "Retry of an approved goal task");
      return this.store.getTask(next.id)!;
    });
  }

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

  createTask(input: NewTask & { scheduleId?: string }): Task {
    // From the API and CLI flags as given. Only an exact "observe" is read-only, so "Observe" would get a writing agent.
    if (!Object.hasOwn(AUTONOMY_LABEL, input.autonomy)) throw new Error(`Unknown autonomy “${input.autonomy}”. Use one of: ${Object.keys(AUTONOMY_LABEL).join(", ")}`);
    if (!Object.hasOwn(KIND_LABEL, input.kind)) throw new Error(`Unknown kind “${input.kind}”. Use one of: ${Object.keys(KIND_LABEL).join(", ")}`);
    if (typeof input.brief !== "string") throw new Error("A task's brief must be text");
    if (input.preApprove !== undefined && typeof input.preApprove !== "boolean") throw new Error("Pre-approval must be a boolean");
    if (input.preApprove && input.autonomy === "observe") throw new Error("This task is investigate-only, so it has nothing to merge");
    if (input.kind !== "factory_feature" && !input.repoId) throw new Error("Choose a repo for this task");
    if (input.kind === "factory_feature" && !input.repoId) {
      input.repoId = this.store.listRepos().find((r) => r.isFactory)?.id ?? null;
    }
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Give the task a title");
    // Nobody else claims an assigned task, so it must name someone on the crew.
    if (input.assignee && !this.store.listAgents().some((a) => a.id === input.assignee)) {
      throw new Error(`No crew member ${input.assignee}`);
    }
    const task = this.store.createTask({
      ...input,
      ...checkTaskRunOptions(input),
      ...this.checkGates(input, input.repoId),
      lookouts: checkLookouts(input.lookouts),
      scheduledAt: checkScheduledAt(input.scheduledAt),
      assignee: input.assignee || null,
      driverSettings: null,
    });
    // Remembered so the next instruction that doesn't name a repo defaults to this one.
    if (task.repoId) this.store.setSetting("last_repo", task.repoId);
    return task;
  }

  /** Reorder waiting work; scheduling, crew assignment and prerequisites still apply. */
  moveQueuedTask(id: string, beforeId: unknown): Task[] {
    if (beforeId !== null && (typeof beforeId !== "string" || !beforeId.trim())) {
      throw new Error("Give beforeId as a task id, or null to move to the end of the queue");
    }
    return this.store.moveQueuedTask(this.need(id).id, beforeId === null ? null : this.need(beforeId).id);
  }

  /** Reschedule queued work, or clear its time without waiving prerequisites. */
  schedule(id: string, scheduledAt: unknown): Task {
    const task = this.need(id);
    const time = checkScheduledAt(scheduledAt);
    if (!this.store.setTaskSchedule(task.id, time)) throw new Error(`Task ${task.id} isn't queued, so its start time can't change`);
    return this.need(task.id);
  }

  /**
   * Prerequisites and acceptance criteria for a new task, checked. Each
   * prerequisite must be an existing task in the same repo, since only its
   * landing there puts its changes in this task's checkout.
   */
  private checkGates(input: TaskGates, repoId: string | null): Required<TaskGates> {
    const acceptance = checkAcceptance(input.acceptance);
    const given: unknown = input.prerequisites ?? [];
    if (!Array.isArray(given) || given.some((id) => typeof id !== "string")) throw new Error("Prerequisites must be a list of task ids");
    const prerequisites: string[] = [];
    for (const raw of given as string[]) {
      const id = raw.trim();
      if (!id) continue;
      const t = this.store.getTask(id);
      if (!t) throw new Error(`No task ${id} to wait for`);
      if (t.repoId !== repoId) throw new Error(`Task ${t.id} is in another repo, so its changes would never reach this one`);
      if (!prerequisites.includes(t.id)) prerequisites.push(t.id);
    }
    if (prerequisites.length > MAX_GATES) throw new Error(`Give at most ${MAX_GATES} prerequisites`);
    return { prerequisites, acceptance };
  }

  /**
   * Let a queued task start without waiting for its prerequisites to land. This
   * is the operator approving a reduced scope: the agent is told their changes
   * may be missing, and works from what's on the default branch.
   */
  waivePrerequisites(id: string, note?: string): Task {
    const m = this.need(id);
    if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
    const waiting = this.store.unmetPrerequisites(m);
    if (!waiting.length) {
      throw new Error(m.prerequisitesWaivedAt ? `Task ${m.id}'s prerequisites are already waived` : `Task ${m.id} isn't waiting for any prerequisites`);
    }
    if (!this.store.waivePrerequisites(m.id)) throw new Error(`Task ${m.id} isn't queued, so there's nothing to start early`);
    const ids = waiting.map((t) => t.id).join(", ");
    this.store.addEvent(m.id, "operator", note ? `Waived prerequisites ${ids}: ${note}` : `Waived prerequisites ${ids}`, {
      waived: waiting.map((t) => t.id),
      ...(note ? { note } : {}),
    });
    return this.need(id);
  }

  private need(id: string): Task {
    const m = this.store.getTask(id);
    if (!m) throw new Error(`No task ${id}`);
    return m;
  }

  /** Record candidate inspection or an explicit waiver; task pre-approval also authorizes waivers. */
  async recordVisualReview(id: string, input: { status: "inspected" | "waived"; commit: string; note: string }): Promise<Task> {
    const task = this.need(id);
    if (!input || !["inspected", "waived"].includes(input.status)) throw new Error("Visual decision must be inspected or waived");
    if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit)) throw new Error("Supply the full candidate commit");
    if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 10000) {
      throw new Error("Record reviewed views, sizes and screenshot paths, or the waiver reason and unreviewed scope (at most 10000 characters)");
    }
    if (!task.branch || !["needs_review", "approved", "done"].includes(task.status)) throw new Error("Visual review requires a finished candidate awaiting approval or merge");
    let candidate = task.visualReview;
    // Older tasks have no structured candidate. Resolve their branch without changing the operator's checkout.
    if (!candidate) {
      const repo = task.repoId ? this.store.getRepo(task.repoId) : null;
      if (!repo) throw new Error("This task has no candidate repo");
      candidate = { status: "pending", commit: await git(repo.path, "rev-parse", `refs/heads/${task.branch}^{commit}`),
        tree: await git(repo.path, "rev-parse", `refs/heads/${task.branch}^{tree}`), note: "", decidedAt: null };
    }
    const expected = candidate;
    return this.store.db.transaction(() => {
      const current = this.need(id);
      if (current.status !== task.status || (current.visualReview?.commit ?? null) !== (task.visualReview?.commit ?? null)
        || input.commit !== expected.commit) throw new Error("The candidate changed; inspect its current commit and record a new decision");
      const review = { ...expected, status: input.status, note: input.note.trim(), decidedAt: new Date().toISOString() };
      this.store.updateTask(id, { visualReview: review });
      this.store.addEvent(id, "operator", input.status === "inspected" ? "Recorded candidate visual inspection" : "Waived candidate visual review", { visualReview: review });
      return this.need(id);
    }).immediate();
  }

  private requireVisualReview(task: Task) {
    if (visualReviewPending(task)) throw new Error("Record candidate visual inspection or an explicit operator waiver before approval or merge");
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
    this.requireVisualReview(m);
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
   * review, waiving visual review too. A failed run or check fails the task as
   * usual, and a merge that can't land comes back for review. `undoPreApproval`
   * takes it back.
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
    this.requireVisualReview(m);
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
    const goalId = this.store.goalForTask(this.need(id).id);
    if (goalId) throw new Error(`This task belongs to goal ${goalId}. Send feedback or retry the task from that goal to preserve its dependencies`);
    return this.retryTask(id, opts);
  }

  private retryTask(id: string, opts: { driver?: string | null } = {}): Task {
    const m = this.need(id);
    const driver = opts.driver === undefined ? m.driver : checkDriver(opts.driver);
    // A maintenance run goes back to the member it was started for.
    const next = this.store.createTask({ kind: m.kind, title: m.title, brief: m.brief, repoId: m.repoId, autonomy: m.autonomy,
      driver, model: driver === m.driver ? m.model : null, effort: driver === m.driver ? m.effort : null, assignee: m.assignee,
      driverSettings: driver === m.driver ? m.driverSettings : null, postmortemOf: m.postmortemOf,
      // The same gates, but not a waiver: that approved the scope of the earlier run only.
      prerequisites: m.prerequisites, acceptance: m.acceptance, lookouts: m.lookouts });
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

  retentionSettings(): RetentionSettings {
    return this.store.retentionSettings();
  }

  configureRetention(input: RetentionSettings): RetentionSettings {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected retention settings");
    const days = input.finishedTaskDays;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) {
      throw new Error("Retention days must be a whole number from 1 to 36500, or null to keep all history");
    }
    this.store.setSetting("retention_finished_task_days", days === null ? "" : String(days));
    return this.retentionSettings();
  }

  /**
   * The agent, model, and effort are captured when a merge queues its read-only
   * post-mortem. `crew` names who runs them, and applies to those already waiting;
   * an empty list leaves them to any active member.
   */
  configurePostmortem(input: { driver?: string | null; model?: string | null; effort?: string | null; crew?: string[] }): PostmortemSettings {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected post-mortem settings");
    const saved = this.postmortemSettings();
    const driver = input.driver === undefined ? saved.driver : checkDriver(input.driver);
    const changed = driver !== saved.driver;
    const crew = input.crew === undefined ? saved.crew : this.checkPostmortemCrew(input.crew);
    const next = { driver, model: changed ? null : saved.model, effort: changed ? null : saved.effort, crew };
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

  private checkPostmortemCrew(crew: unknown): string[] {
    if (!Array.isArray(crew)) throw new Error("Choose who runs post-mortems as a list of crew members");
    const members = new Set(this.store.listAgents().map((a) => a.id));
    for (const id of crew) if (!members.has(id as string)) throw new Error(`No crew member ${String(id)}`);
    return [...new Set(crew as string[])];
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
   * Start a crew member's maintenance run, defaulting to Crane's own repo. The task is
   * assigned to that member, so only they pick it up, at their role's freedom.
   */
  async runRole(id: string, opts: RoleRunOptions & { preApprove?: boolean; scheduleId?: string } = {}): Promise<Task> {
    const member = this.store.listAgents().find((a) => a.id === id);
    if (!member) throw new Error(`No crew member ${id}`);
    if (!member.role) throw new Error(`${member.name} has no maintenance role. Give them one first`);
    if (!member.active) throw new Error(`${member.name} is on-call. Activate them first, so the run doesn't wait in the queue`);
    if (opts.repoId !== undefined && (typeof opts.repoId !== "string" || !opts.repoId.trim())) {
      throw new Error("Choose a connected repo for this run");
    }
    const repo = opts.repoId === undefined ? await this.ensureFactoryRepo() : this.needRepo(opts.repoId);
    if (!repo) throw new Error("Crane's own repo isn't connected, so there's nothing to maintain");
    return this.store.db.transaction(() => this.createRoleRun(id, repo, opts)).immediate();
  }

  private createRoleRun(id: string, repo: Repo, opts: RoleRunOptions & { preApprove?: boolean; scheduleId?: string }): Task {
    const member = this.store.listAgents().find((a) => a.id === id);
    if (!member) throw new Error(`No crew member ${id}`);
    if (!member.role) throw new Error(`${member.name} has no maintenance role. Give them one first`);
    if (!member.active) throw new Error(`${member.name} is on-call. Activate them first, so the run doesn't wait in the queue`);
    if (opts.scheduleId && (this.store.isPaused() || member.state === "paused")) throw new Error(`${member.name} is paused`);
    // Recurring slots skip any open run; manual runs may target another repo.
    const open = this.store.listTasks({
      status: opts.scheduleId ? ["queued", "running", "needs_review", "merging"] : ["queued", "running"],
      repoId: opts.scheduleId ? undefined : repo.id,
      assignee: member.id,
      limit: 1,
    })[0];
    if (open) throw new Error(`${member.name} already has a run under way: ${open.id} · ${open.title}`);

    const schedule = opts.scheduleId ? this.store.listCrewSchedules(id).find((s) => s.id === opts.scheduleId) : undefined;
    if (opts.scheduleId && !schedule) throw new Error("No such crew schedule");
    const role = MAINTENANCE_ROLE[member.role];
    const task = this.createTask({
      kind: "maintenance",
      title: `${role.action} in ${repo.name}`,
      brief: `${role.brief}\n\nStarted from ${member.name}'s maintenance role: ${role.label}.`,
      repoId: repo.id,
      autonomy: role.autonomy,
      assignee: member.id,
      scheduledAt: opts.scheduledAt,
      scheduleId: schedule?.id,
    });
    this.store.addEvent(task.id, "operator", `Started ${member.name}'s ${role.label.toLowerCase()} run`, {
      agentId: member.id,
      role: member.role,
      repoId: repo.id,
    });
    if (schedule) {
      this.store.addEvent(task.id, "operator", `Started by ${member.name}'s ${crewScheduleLabel(schedule)} schedule`, { scheduleId: schedule.id });
    }
    return opts.preApprove ? this.preApprove(task.id) : this.store.getTask(task.id)!;
  }

  listCrewSchedules(agentId?: string): CrewSchedule[] {
    if (agentId && !this.store.listAgents().some((a) => a.id === agentId)) throw new Error(`No crew member ${agentId}`);
    return this.store.listCrewSchedules(agentId);
  }

  saveCrewSchedule(agentId: string, input: CrewScheduleInput, id?: string): CrewSchedule {
    validateCrewSchedule(input);
    const member = this.store.listAgents().find((a) => a.id === agentId);
    if (!member) throw new Error(`No crew member ${agentId}`);
    if (!member.role && input.enabled) throw new Error(`${member.name} has no maintenance role. Give them one first`);
    const repo = this.store.getRepo(input.repoId);
    if (!repo) throw new Error(`No repo ${input.repoId}`);
    if (id && !this.listCrewSchedules(agentId).some((s) => s.id === id)) throw new Error("No such crew schedule");
    if (input.enabled && input.preApprove && member.role && MAINTENANCE_ROLE[member.role].autonomy === "observe") throw new Error("Investigate-only runs cannot be pre-approved");
    return this.store.saveCrewSchedule(id ?? shortId("cs"), agentId, { ...input, repoId: repo.id }, nextCrewFire(input, Date.now()));
  }

  removeCrewSchedule(agentId: string, id: string): void {
    if (!this.listCrewSchedules(agentId).some((s) => s.id === id)) throw new Error("No such crew schedule");
    this.store.removeCrewSchedule(id);
  }

  /** Catch up once. Claim, creation and outcome commit together, including across processes. */
  fireCrewSchedules(at = Date.now()): void {
    const firedAt = new Date(at).toISOString();
    for (const due of this.store.listCrewSchedules().filter((s) => s.enabled && s.nextFireAt <= firedAt)) {
      this.store.db.transaction(() => {
        // Read policy again under the write lock: an edit or pause may have
        // happened since the due list was read by this process.
        const s = this.store.listCrewSchedules().find((s) => s.id === due.id);
        if (!s || !s.enabled || s.nextFireAt > firedAt) return;
        if (!this.store.claimCrewSchedule(s, nextCrewFire(s, at), firedAt)) return;
        try {
          // A savepoint rolls back task creation too if pre-approval fails.
          const task = this.store.db.transaction(() => {
            const repo = this.store.getRepo(s.repoId);
            if (!repo) throw new Error("Repo is no longer connected");
            return this.createRoleRun(s.agentId, repo, { preApprove: s.preApprove, scheduleId: s.id });
          })();
          this.store.crewScheduleOutcome(s.id, `Queued ${task.id}`);
        } catch (err) {
          this.store.crewScheduleOutcome(s.id, `Skipped: ${(err as Error).message}`);
        }
      }).immediate();
    }
  }

  /**
   * Turn one finding from a report into its own task that is allowed to make
   * the change, optionally waiting on prerequisites, held to acceptance
   * criteria, and looking out for more along the way.
   */
  followUp(id: string, findingIndex: number, opts: TaskRunOptions & TaskGates & Pick<NewTask, "lookouts"> = {}): Task {
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
    const gates = this.checkGates(opts, m.repoId);
    const lookouts = checkLookouts(opts.lookouts);
    const next = this.store.createTask({
      kind: m.kind,
      title: f.title,
      brief: `${f.detail}\n\nFollow-up to task ${m.id}: “${m.title}”.`,
      repoId: m.repoId,
      autonomy: "propose",
      ...settings,
      ...gates,
      lookouts,
      followUp: { of: m.id, finding: findingIndex },
    });
    this.store.addEvent(m.id, "operator", `Started follow-up ${next.id}: ${f.title}`, { taskId: next.id, finding: findingIndex });
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

  /**
   * Replace the commands a repo's work must pass before review and merge. Saving
   * none is allowed, and stops that work passing either gate. Bad input leaves the
   * saved checks alone. Resolves the repo first because checks are stored by id.
   */
  configureChecks(repoId: string, input: unknown): string[] {
    const repo = this.needRepo(repoId);
    if (!Array.isArray(input) || input.some((c) => typeof c !== "string" || !c.trim())) {
      throw new Error("Expected an array of nonempty commands");
    }
    const commands = input.map((c: string) => c.trim());
    this.store.setRepoChecks(repo.id, commands);
    return commands;
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
