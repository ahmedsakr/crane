import Database from "better-sqlite3";
import { basename } from "node:path";
import { dbPath } from "./paths.js";
import { shortId } from "./ids.js";
import { SCHEMA } from "./store/schema.js";
import { addMissingColumns, migrateMissionsToTasks, migrateFollowUpLinks, migratePostmortemLinks,
  migratePostmortemBriefs, migrateCostsToRuns, migrateCostStatus } from "./store/migrations.js";
import { toRepo, toTask, toEvent, toRun, toAgent, localDayStart, type Row } from "./store/rows.js";
import {
  errorMessage,
  ACTIVE_STATUSES,
  ALL_STATUSES,
  FINISHED_STATUSES,
  SHIPPED_STATUSES,
  UNSHIPPED_STATUSES,
  isMaintenanceRole,
  lastMergeOutcome,
  prerequisiteMet,
  ruleLabel,
  unmetAcceptance,
  completionReviewReason,
  validateGoalPlan,
  goalWaves,
  type Goal,
  type GoalDetail,
  type GoalPlan,
  type GoalSummary,
  type MaintenanceRole,
  type CrewSchedule,
  type CrewScheduleInput,
  type FollowUpSource,
  type FollowUpState,
  type PrerequisiteState,
  type CommandEvidence,
  type VisualReview,
} from "@crane/contracts";
import { postmortemBrief, postmortemPrompt, postmortemSourceMissing } from "./postmortem.js";
import type {
  Agent,
  AgentRun,
  AgentState,
  Analytics,
  BlockedTool,
  RunKind,
  RunOutcome,
  RunUsage,
  TaskKind,
  EventType,
  RepoTools,
  Task,
  TaskSummary,
  TaskEvent,
  TaskStatus,
  NewTask,
  Overview,
  Repo,
  DriverSettings,
  PostmortemSettings,
  RetentionSettings,
} from "@crane/contracts";

/** A commit a merged prerequisite put on the default branch. */
export interface LandedCommit {
  id: string;
  title: string;
  commit: string;
}

type TaskListOptions = { status?: TaskStatus[]; repoId?: string; assignee?: string; limit?: number };
const TASK_SUMMARY_COLUMNS = `id, kind, title, repo_id AS repoId, status, branch, assignee,
  postmortem_of AS postmortemOf,
  created_at AS createdAt, scheduled_at AS scheduledAt,
  started_at AS startedAt, finished_at AS finishedAt,
  json_extract(report, '$.summary') AS reportSummary,
  COALESCE(json_array_length(report, '$.findings'), 0) AS findingCount,
  COALESCE(json_array_length(report, '$.changedFiles'), 0) AS changedFileCount`;

/** Task fields updateTask can persist, mapped to their database columns. */
const TASK_UPDATE_COLUMNS = {
  status: "status",
  agentId: "agent_id",
  branch: "branch",
  worktree: "worktree",
  sessionId: "session_id",
  report: "report",
  visualReview: "visual_review",
  reviewCheckpoint: "review_checkpoint",
  costUsd: "cost_usd",
  startedAt: "started_at",
  finishedAt: "finished_at",
  title: "title",
} satisfies Partial<Record<keyof Task, string>>;

type TaskPatch = Partial<Pick<Task, keyof typeof TASK_UPDATE_COLUMNS>>;

const now = () => new Date().toISOString();
const TASK_DUE = "(scheduled_at IS NULL OR scheduled_at <= ?)";

/** The settings that hold the operator's choices for one crew member. */
export const crewSettingKey = {
  active: (agentId: string) => `crew_active_${agentId}`,
  defaultDriver: (agentId: string) => `crew_driver_${agentId}`,
  role: (agentId: string) => `crew_role_${agentId}`,
};

/**
 * The single source of truth. Every process (the factory server, the CLI)
 * opens the same SQLite file in WAL mode, so the CLI works whether or not
 * the factory is running, and live views just tail the events table.
 */
export class Store {
  readonly db: Database.Database;
  private refusalTotalsCache: { version: string; rows: Row[] } | null = null;

  constructor(file = dbPath()) {
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    // This is cheap before the first schema is created. Existing databases are
    // converted by opt-in maintenance, never by an ordinary CLI/store open.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get()) {
      this.db.pragma("auto_vacuum = INCREMENTAL");
    }
    this.db.pragma("journal_mode = WAL");
    migrateMissionsToTasks(this.db);
    this.db.exec(SCHEMA);
    addMissingColumns(this.db);
    migrateFollowUpLinks(this.db);
    migratePostmortemLinks(this.db);
    migratePostmortemBriefs(this.db);
    migrateCostsToRuns(this.db);
    migrateCostStatus(this.db);
  }

  /** Execute atomically; nested calls use SQLite savepoints. */
  transaction<T>(fn: () => T, options: { immediate?: boolean } = {}): T {
    const transaction = this.db.transaction(fn);
    if (options.immediate) return transaction.immediate();
    return transaction();
  }

  close() {
    this.db.close();
  }

  // Goals retain every research revision and its task links across restarts.
  getGoal(id: string): Goal | null {
    const row = this.db.prepare("SELECT data FROM goals WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Goal : null;
  }

  listGoals(): Goal[] {
    return (this.db.prepare("SELECT data FROM goals ORDER BY rowid DESC").all() as { data: string }[])
      .map((row) => JSON.parse(row.data) as Goal);
  }

  listGoalSummaries(needsReview = false): GoalSummary[] {
    return this.db.prepare(`SELECT id, status,
      json_extract(data, '$.title') AS title, json_extract(data, '$.repoId') AS repoId,
      json_array_length(data, '$.tasks') AS taskCount FROM goals
      ${needsReview ? "WHERE status IN ('needs_review', 'blocked')" : ""} ORDER BY rowid DESC`)
      .all() as GoalSummary[];
  }

  goalDetail(id: string): GoalDetail {
    const goal = this.getGoal(id);
    if (!goal) throw new Error(`No goal ${id}`);
    return { goal, research: this.getTask(goal.researchTaskId),
      tasks: goal.tasks.flatMap((t) => { const task = this.getTask(t.taskId); return task ? [task] : []; }) };
  }

  goalForTask(taskId: string): string | null {
    const row = this.db.prepare("SELECT goal_id FROM goal_tasks WHERE task_id = ?").get(taskId) as { goal_id: string } | undefined;
    return row?.goal_id ?? null;
  }

  private writeGoal(goal: Goal) {
    this.db.prepare("INSERT INTO goals(id, status, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data")
      .run(goal.id, goal.status, JSON.stringify(goal));
  }

  private linkGoalTask(goalId: string, taskId: string) {
    this.db.prepare("INSERT INTO goal_tasks(task_id, goal_id) VALUES(?, ?)").run(taskId, goalId);
    this.addEvent(taskId, "note", `Part of goal ${goalId}`, { goalId });
  }

  createGoal(input: Pick<Goal, "title" | "outcome" | "repoId" | "research">, researchTask: NewTask): Goal {
    return this.db.transaction(() => {
      const ts = now();
      const task = this.createTask(researchTask);
      const goal: Goal = { ...input, id: shortId("g"), status: "researching", revision: 1, plan: null,
        researchTaskId: task.id, feedback: [], tasks: [], autoMerge: false, approvedAt: null,
        createdAt: ts, updatedAt: ts, error: null };
      this.writeGoal(goal);
      this.linkGoalTask(goal.id, task.id);
      return goal;
    }).immediate();
  }

  /** Version checks prevent stale tabs and duplicate decisions from starting extra work. */
  private goalAtRevision(id: string, revision: unknown): Goal {
    const goal = this.getGoal(id);
    if (!goal) throw new Error(`No goal ${id}`);
    if (!Number.isSafeInteger(revision) || goal.revision !== revision) throw new Error("The goal changed. Reload it before deciding");
    return goal;
  }

  private editableGoal(id: string, revision: unknown): Goal {
    const goal = this.goalAtRevision(id, revision);
    if (goal.approvedAt || !["needs_review", "blocked"].includes(goal.status)) throw new Error("Wait for research to finish; approved goals cannot be replanned");
    return goal;
  }

  reviseGoal(id: string, revision: unknown, feedback: string, researchTask: NewTask): Goal {
    return this.db.transaction(() => {
      const goal = this.editableGoal(id, revision);
      const task = this.createTask(researchTask);
      goal.revision++;
      goal.feedback.push({ revision: goal.revision, text: feedback, taskId: task.id });
      goal.researchTaskId = task.id;
      goal.status = "researching";
      goal.error = null;
      goal.updatedAt = now();
      this.writeGoal(goal);
      this.linkGoalTask(id, task.id);
      return goal;
    }).immediate();
  }

  saveGoalPlan(id: string, revision: unknown, plan: GoalPlan): Goal {
    return this.db.transaction(() => {
      const goal = this.editableGoal(id, revision);
      goal.plan = validateGoalPlan(plan);
      goal.revision++;
      goal.status = "needs_review";
      goal.error = null;
      goal.updatedAt = now();
      this.writeGoal(goal);
      this.addEvent(goal.researchTaskId, "operator", "Edited goal plan", { goalId: id, revision: goal.revision });
      return goal;
    }).immediate();
  }

  /** Queue the entire approved DAG in one write transaction; claims cannot see a partial graph. */
  approveGoal(id: string, revision: unknown, autoMerge: boolean): Goal {
    return this.db.transaction(() => {
      const goal = this.editableGoal(id, revision);
      if (goal.status !== "needs_review" || !goal.plan) throw new Error("A valid researched plan is required before approval");
      const plan = validateGoalPlan(goal.plan);
      const repo = this.getRepo(goal.repoId);
      if (!repo) throw new Error("The goal's repo is no longer connected");
      const checks = this.repoChecks(repo.id);
      for (const item of plan.tasks) {
        const missing = item.acceptanceChecks?.find((command) => !checks.includes(command));
        if (missing) throw new Error(`${item.key} requires “${missing}”, which isn't one of this repo's checks, so Crane would never run it`);
      }
      const ids = new Map<string, string>();
      for (const wave of goalWaves(plan)) {
        for (const item of wave) {
          const task = this.createTask({ title: item.title,
            brief: `Goal: ${goal.outcome}\n\nPlan: ${plan.summary}\n\nApproach: ${plan.approach}\n\nYour task (${item.key}):\n${item.brief}\n\nAssignment rationale: ${item.rationale}`,
            kind: repo.isFactory ? "factory_feature" : "repo_feature", repoId: repo.id, autonomy: "propose",
            driver: item.driver, model: item.model, effort: item.effort,
            prerequisites: item.dependsOn.map((key) => ids.get(key)!), acceptance: item.acceptance, acceptanceChecks: item.acceptanceChecks,
            lookouts: ["improvements", "refactoring"], preApprove: autoMerge });
          ids.set(item.key, task.id);
          this.linkGoalTask(id, task.id);
        }
      }
      goal.tasks = plan.tasks.map((t) => ({ key: t.key, taskId: ids.get(t.key)! }));
      goal.revision++;
      goal.status = "active";
      goal.autoMerge = autoMerge;
      goal.approvedAt = goal.updatedAt = now();
      this.writeGoal(goal);
      this.addEvent(goal.researchTaskId, "operator", "Approved goal plan", { goalId: id, revision, autoMerge });
      return goal;
    }).immediate();
  }

  cancelGoal(id: string, revision: unknown): Goal {
    return this.db.transaction(() => {
      const goal = this.goalAtRevision(id, revision);
      if (["completed", "cancelled"].includes(goal.status)) throw new Error("This goal has already ended");
      // Running work and merges use the usual task cancellation path/worker guard.
      const ids = [goal.researchTaskId, ...goal.tasks.map((t) => t.taskId)];
      if (ids.some((id) => this.getTask(id)?.status === "merging")) throw new Error("Wait for the current merge to finish before cancelling the goal");
      for (const taskId of ids) {
        const task = this.getTask(taskId);
        if (task && ["queued", "running", "needs_review", "done", "approved"].includes(task.status)) {
          this.setStatus(taskId, "cancelled", "Goal cancelled by the operator");
        }
      }
      goal.status = "cancelled";
      goal.revision++;
      goal.updatedAt = now();
      this.writeGoal(goal);
      return goal;
    }).immediate();
  }

  /** Reconcile persisted task results, including after a crash between task completion and the next tick. */
  syncGoals(): void {
    const pending = this.db.prepare("SELECT id FROM goals WHERE status IN ('researching', 'active', 'blocked')").all() as { id: string }[];
    for (const snapshot of pending) {
      this.db.transaction(() => {
        const goal = this.getGoal(snapshot.id)!;
        if (!["researching", "active", "blocked"].includes(goal.status)) return;
        if (goal.status === "researching") {
          const task = this.getTask(goal.researchTaskId);
          if (task && ["queued", "running"].includes(task.status)) return;
          try {
            if (!task || !["done", "needs_review", "approved"].includes(task.status)) throw new Error("Research failed or was cancelled. Send feedback to research again");
            if (task.report?.completion?.status !== "completed") throw new Error("Research did not report completed planning. Review the research report and send feedback");
            goal.plan = validateGoalPlan(task.report.goalPlan);
            goal.status = "needs_review";
            goal.error = null;
          } catch (err) {
            goal.status = "blocked";
            goal.error = errorMessage(err);
          }
          if (goal.status === "needs_review" && task?.status === "needs_review") {
            this.setStatus(task.id, "done", "Research complete; review the plan on its goal", { goalId: goal.id });
          }
        } else if (goal.approvedAt) {
          // Poll statuses alone: agent reports and briefs can be large while work is in flight.
          const tasks = this.db.prepare(`SELECT status FROM tasks WHERE id IN (${goal.tasks.map(() => "?").join(",")})`)
            .all(...goal.tasks.map((t) => t.taskId)) as { status: TaskStatus }[];
          const failed = tasks.length !== goal.tasks.length || tasks.some((t) => ["failed", "cancelled", "rejected"].includes(t.status));
          const complete = tasks.length > 0 && tasks.every((t) => t.status === "merged");
          const status = complete ? "completed" : failed ? "blocked" : "active";
          if (status === goal.status) return;
          goal.status = status;
          goal.error = failed ? "A goal task failed, was declined, or was cancelled. Retry it from this goal to reconnect its dependents" : null;
        } else return;
        goal.revision++;
        goal.updatedAt = now();
        this.writeGoal(goal);
      }).immediate();
    }
  }

  retryGoalTask(id: string, revision: unknown, taskId: string, retry: () => Task): Goal {
    return this.db.transaction(() => {
      const goal = this.goalAtRevision(id, revision);
      if (!goal.approvedAt || !["active", "blocked"].includes(goal.status)) throw new Error("Only executing goals can retry a task");
      const link = goal.tasks.find((t) => t.taskId === taskId);
      if (!link) throw new Error("This task does not belong to the goal");
      const old = this.getTask(taskId);
      if (!old || !["failed", "cancelled", "rejected"].includes(old.status)) throw new Error("Only failed, cancelled or declined goal tasks can be retried");
      const next = retry();
      link.taskId = next.id;
      this.linkGoalTask(id, next.id);
      // Retry copies the approved task, including gates. Rewire waiting children, including a retry's own gates.
      for (const item of goal.tasks) {
        const task = this.getTask(item.taskId);
        if (task?.status === "queued" && task.prerequisites.includes(taskId)) {
          this.db.prepare("UPDATE tasks SET prerequisites = ? WHERE id = ?")
            .run(JSON.stringify(task.prerequisites.map((p) => p === taskId ? next.id : p)), task.id);
          this.addEvent(task.id, "operator", `Goal prerequisite ${taskId} replaced by retry ${next.id}`, { goalId: id });
        }
      }
      goal.revision++;
      goal.updatedAt = now();
      this.writeGoal(goal);
      return goal;
    }).immediate();
  }

  listCrewSchedules(agentId?: string): CrewSchedule[] {
    const rows = this.db.prepare(`SELECT * FROM crew_schedules ${agentId ? "WHERE agent_id = ?" : ""} ORDER BY next_fire_at, id`)
      .all(...(agentId ? [agentId] : [])) as Row[];
    return rows.map((r) => ({
      id: r.id as string, agentId: r.agent_id as string, repoId: r.repo_id as string,
      daysMask: r.days_mask as number, localTime: r.local_time as string, timezone: r.timezone as string,
      preApprove: !!r.pre_approve, enabled: !!r.enabled, nextFireAt: r.next_fire_at as string,
      lastFiredAt: r.last_fired_at as string | null, lastOutcome: r.last_outcome as string | null,
    }));
  }

  saveCrewSchedule(id: string, agentId: string, input: CrewScheduleInput, nextFireAt: string): CrewSchedule {
    this.db.prepare(`INSERT INTO crew_schedules(id, agent_id, repo_id, days_mask, local_time, timezone, pre_approve, enabled, next_fire_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      repo_id=excluded.repo_id, days_mask=excluded.days_mask, local_time=excluded.local_time,
      timezone=excluded.timezone, pre_approve=excluded.pre_approve, enabled=excluded.enabled, next_fire_at=excluded.next_fire_at`)
      .run(id, agentId, input.repoId, input.daysMask, input.localTime, input.timezone, +input.preApprove, +input.enabled, nextFireAt);
    return this.listCrewSchedules(agentId).find((s) => s.id === id)!;
  }

  removeCrewSchedule(id: string): void {
    this.db.prepare("DELETE FROM crew_schedules WHERE id = ?").run(id);
  }

  /** Must run inside the same transaction as task creation and outcome recording. */
  claimCrewSchedule(s: CrewSchedule, next: string, firedAt: string): boolean {
    return !!this.db.prepare(`UPDATE crew_schedules SET next_fire_at = ?, last_fired_at = ?
      WHERE id = ? AND enabled = 1 AND next_fire_at = ?`).run(next, firedAt, s.id, s.nextFireAt).changes;
  }

  crewScheduleOutcome(id: string, outcome: string): void {
    this.db.prepare("UPDATE crew_schedules SET last_outcome = ? WHERE id = ?").run(outcome, id);
  }

  // ── settings ──────────────────────────────────────────────
  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return (r?.value as string) ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  retentionSettings(): RetentionSettings {
    const days = Number(this.getSetting("retention_finished_task_days"));
    return { finishedTaskDays: Number.isInteger(days) && days >= 1 && days <= 36500 ? days : null };
  }

  /**
   * Bounded batches; the predicate is checked under the same lock as deletion.
   * A post-mortem builds its prompt from its source task's events when it runs,
   * so a source keeps them while one is queued or running.
   */
  pruneTaskHistory(cutoff: string, days: number): number {
    return this.db.transaction(() => {
      const removed = this.db.prepare(`DELETE FROM events WHERE id IN (
        SELECT e.id FROM tasks t JOIN events e ON e.task_id = t.id
        WHERE t.status IN (${FINISHED_STATUSES.map(() => "?").join(",")})
          AND t.finished_at < ? AND e.ts < ?
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.outcome = 'running')
          AND t.id NOT IN (SELECT postmortem_of FROM tasks WHERE postmortem_of IS NOT NULL AND status IN ('queued', 'running'))
          AND (e.type = 'tool' OR (e.type = 'note'
            AND CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.routine') END = 1))
        ORDER BY e.id LIMIT 5000
      ) RETURNING task_id`).all(...FINISHED_STATUSES, cutoff, cutoff) as { task_id: string }[];
      const counts = new Map<string, number>();
      for (const r of removed) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
      for (const [id, count] of counts) this.addEvent(id, "note", `Trimmed ${count} routine history events under the ${days}-day retention setting`, {
        retention: { days, cutoff, events: count },
      });
      return removed.length;
    }).immediate();
  }

  /** The first opt-in sweep needs one full rewrite to convert older databases. */
  vacuumHistory(): void {
    if (this.db.pragma("auto_vacuum", { simple: true }) !== 2) {
      this.db.pragma("auto_vacuum = INCREMENTAL");
      this.db.exec("VACUUM");
    }
    // Bounded reclamation on later sweeps, rather than another full VACUUM.
    this.db.pragma("incremental_vacuum(1000)");
  }

  private savedPostmortemSettings(): Partial<PostmortemSettings> {
    const saved = this.getSetting("postmortem_settings");
    return saved ? JSON.parse(saved) as Partial<PostmortemSettings> : {};
  }

  postmortemSettings(): PostmortemSettings {
    const saved = this.savedPostmortemSettings();
    return { driver: saved.driver ?? null, model: saved.model ?? null, effort: saved.effort ?? null, crew: this.postmortemCrew() };
  }

  /**
   * Who the operator named to run post-mortems; empty leaves them to any active
   * member. Anyone who has left the crew drops out, so they can't strand a review.
   */
  postmortemCrew(): string[] {
    const named = this.savedPostmortemSettings().crew ?? [];
    if (!named.length) return [];
    const crew = new Set((this.db.prepare("SELECT id FROM agents").all() as Row[]).map((a) => a.id));
    return named.filter((id) => crew.has(id));
  }

  setPostmortemSettings(settings: PostmortemSettings) {
    this.setSetting("postmortem_settings", JSON.stringify(settings));
  }

  isPaused(): boolean {
    return this.getSetting("paused") === "1";
  }

  setPaused(paused: boolean) {
    this.setSetting("paused", paused ? "1" : "0");
  }

  // ── repos ─────────────────────────────────────────────────
  listRepos(): Repo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY is_factory DESC, name").all() as Row[]).map(toRepo);
  }

  getRepo(idOrName: string): Repo | null {
    const r = this.db
      .prepare("SELECT * FROM repos WHERE id = ? OR name = ? OR path = ?")
      .get(idOrName, idOrName, idOrName) as Row | undefined;
    return r ? toRepo(r) : null;
  }

  addRepo(input: { path: string; name?: string; defaultBranch?: string; isFactory?: boolean }): Repo {
    const existing = this.getRepo(input.path);
    if (existing) return existing;
    const repo: Repo = {
      id: shortId("r", 4),
      name: input.name ?? basename(input.path),
      path: input.path,
      defaultBranch: input.defaultBranch ?? "main",
      isFactory: !!input.isFactory,
      addedAt: now(),
    };
    this.db
      .prepare("INSERT INTO repos(id, name, path, default_branch, is_factory, added_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(repo.id, repo.name, repo.path, repo.defaultBranch, repo.isFactory ? 1 : 0, repo.addedAt);
    return repo;
  }

  removeRepo(id: string) {
    this.db.prepare("DELETE FROM repos WHERE id = ? AND is_factory = 0").run(id);
  }

  /** The tool rules the operator has allowed, or chosen to keep blocked, for one repo. */
  repoTools(repoId: string): RepoTools {
    const raw = this.getSetting(`tools:${repoId}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<RepoTools>) : {};
    return { allowed: parsed.allowed ?? [], keptBlocked: parsed.keptBlocked ?? [] };
  }

  repoChecks(repoId: string): string[] {
    const raw = this.getSetting(`checks:${repoId}`);
    if (raw) return JSON.parse(raw) as string[];
    return this.getRepo(repoId)?.isFactory ? ["npm run typecheck", "npm test"] : [];
  }

  setRepoChecks(repoId: string, commands: string[]) {
    this.setSetting(`checks:${repoId}`, JSON.stringify(commands));
  }

  setRepoTools(repoId: string, tools: RepoTools) {
    this.setSetting(`tools:${repoId}`, JSON.stringify({ allowed: [...new Set(tools.allowed)], keptBlocked: [...new Set(tools.keptBlocked)] }));
  }

  /**
   * Every refused rule, added up per repo, most widespread first. Only a change
   * to the blocked events can change the answer, and any process may write one,
   * so each call asks the database whether they did. The count catches deletions
   * the latest id can't see.
   */
  private refusalTotals(): Row[] {
    const latest = this.db.prepare("SELECT COUNT(*) AS n, MAX(id) AS id FROM events WHERE type = 'blocked'").get() as Row;
    const version = `${latest.n}:${latest.id}`;
    if (this.refusalTotalsCache?.version === version) return this.refusalTotalsCache.rows;
    // SQLite takes bare columns from the row holding the only MAX(), so ts and task_id both describe the latest refusal.
    const rows = this.db
      .prepare(
        `SELECT t.repo_id AS repo_id, p.name AS repo_name, r.value AS rule,
                COUNT(DISTINCT e.task_id) AS tasks, COUNT(*) AS times,
                MAX(e.id) AS last_id, e.ts AS last_at, e.task_id AS last_task_id
         FROM events e
         JOIN tasks t ON t.id = e.task_id
         JOIN repos p ON p.id = t.repo_id
         , json_each(e.data, '$.rules') r
         WHERE e.type = 'blocked'
         GROUP BY t.repo_id, r.value
         ORDER BY tasks DESC, last_at DESC`,
      )
      .all() as Row[];
    this.refusalTotalsCache = { version, rows };
    return rows;
  }

  /**
   * Rules agents were refused, added up per repo across tasks. Leaves out
   * rules the operator has already allowed or kept blocked for that repo.
   */
  blockedTools(opts: { repoId?: string; taskId?: string; minTasks?: number } = {}): BlockedTool[] {
    // Every task's count, but only for rules this task hit.
    const taskRules = opts.taskId ? new Set(
      (this.db
        .prepare("SELECT r.value AS rule FROM events e, json_each(e.data, '$.rules') r WHERE e.task_id = ? AND e.type = 'blocked'")
        .all(opts.taskId) as Row[]).map((r) => r.rule),
    ) : null;
    const rows = this.refusalTotals().filter((r) =>
      (!opts.repoId || r.repo_id === opts.repoId)
      && (r.tasks as number) >= (opts.minTasks ?? 1)
      && (!taskRules || taskRules.has(r.rule)));
    const decided = new Map<string, Set<string>>();
    const isDecided = (repoId: string, rule: string) => {
      if (!decided.has(repoId)) {
        const t = this.repoTools(repoId);
        decided.set(repoId, new Set([...t.allowed, ...t.keptBlocked]));
      }
      return decided.get(repoId)!.has(rule);
    };
    return rows
      .filter((r) => !isDecided(r.repo_id as string, r.rule as string))
      .map((r) => ({
        repoId: r.repo_id as string,
        repoName: r.repo_name as string,
        rule: r.rule as string,
        label: ruleLabel(r.rule as string),
        tasks: r.tasks as number,
        times: r.times as number,
        lastAt: r.last_at as string,
        lastTaskId: r.last_task_id as string,
      }));
  }

  // ── tasks ─────────────────────────────────────────────────
  createTask(input: NewTask & {
    driverSettings?: DriverSettings | null;
    /** The recurring crew schedule that started this task. */
    scheduleId?: string;
    /** The task and finding (0-based) this one follows up on. */
    followUp?: { of: string; finding: number };
    /** The merged task this post-mortem reviews. */
    postmortemOf?: string | null;
  }): Task {
    return this.db.transaction(() => {
      const id = shortId("t");
      const ts = now();
      const scheduledAt = input.scheduledAt == null ? null : new Date(input.scheduledAt).toISOString();
      const list = (xs: string[] | undefined) => (xs?.length ? JSON.stringify(xs) : null);
      this.db
        .prepare(
          `INSERT INTO tasks(id, kind, title, brief, repo_id, autonomy, driver, model, effort, assignee, driver_settings,
             prerequisites, acceptance, acceptance_checks, lookouts, status, created_at, scheduled_at, pre_approved_at, follow_up_of, follow_up_finding, schedule_id, postmortem_of, queue_position)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX(queue_position), 0) + 1 FROM tasks WHERE status = 'queued'))`,
        )
        .run(id, input.kind, input.title, input.brief, input.repoId, input.autonomy, input.driver ?? null,
          input.model ?? null, input.effort ?? null, input.assignee ?? null,
          input.driverSettings ? JSON.stringify(input.driverSettings) : null,
          list(input.prerequisites), list(input.acceptance), list(input.acceptanceChecks), list(input.lookouts), ts, scheduledAt, input.preApprove ? ts : null,
          input.followUp?.of ?? null, input.followUp?.finding ?? null, input.scheduleId ?? null, input.postmortemOf ?? null);
      this.addEvent(id, "status", scheduledAt ? `Scheduled for ${scheduledAt}` : "Queued", {
        status: "queued", ...(scheduledAt ? { scheduledAt } : {}),
      });
      if (input.preApprove) this.addEvent(id, "operator", "Pre-approved", { preApproved: true });
      const task = this.getTask(id)!;
      const waiting = this.unmetPrerequisites(task);
      if (waiting.length) {
        this.addEvent(id, "note", `Waits for ${waiting.map((t) => t.id).join(", ")} to land before it starts`, {
          prerequisites: waiting.map((t) => t.id),
        });
      }
      return task;
    }).immediate();
  }

  /** The entire waiting queue, in pickup order, including tasks not yet eligible. */
  listQueuedTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY queue_position, created_at, rowid")
      .all() as Row[]).map(toTask);
  }

  /** The entire pickup order, with the same lightweight payload as other polled rows. */
  listQueuedTaskSummaries(): TaskSummary[] {
    return this.db.prepare(`SELECT ${TASK_SUMMARY_COLUMNS} FROM tasks
      WHERE status = 'queued' ORDER BY queue_position, created_at, rowid`).all() as TaskSummary[];
  }

  /** Move relative to a live anchor, without overwriting concurrent queue changes. */
  moveQueuedTask(id: string, beforeId: string | null): Task[] {
    return this.db.transaction(() => {
      const queue = this.listQueuedTasks();
      const from = queue.findIndex(t => t.id === id);
      if (from < 0) throw new Error(`Task ${id} isn't queued; refresh the queue and try again`);
      if (beforeId !== null && !queue.some(t => t.id === beforeId)) {
        throw new Error(`Task ${beforeId} isn't queued; refresh the queue and try again`);
      }
      if (id === beforeId) return queue;
      const task = queue[from]!;
      queue.splice(from, 1);
      const to = beforeId === null ? queue.length : queue.findIndex(t => t.id === beforeId);
      queue.splice(to, 0, task);
      if (from === to) return queue;
      const update = this.db.prepare("UPDATE tasks SET queue_position = ? WHERE id = ?");
      queue.forEach((t, i) => update.run(i + 1, t.id));
      this.addEvent(id, "operator", beforeId === null ? "Moved to the end of the queue" : `Moved before ${beforeId} in the queue`, { beforeId });
      return queue;
    }).immediate();
  }

  /** Change pickup time only while queued, and record the decision with the write. */
  setTaskSchedule(id: string, scheduledAt: string | null): boolean {
    scheduledAt = scheduledAt === null ? null : new Date(scheduledAt).toISOString();
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ? AND status = 'queued'")
        .run(scheduledAt, id).changes;
      if (!changed) return false;
      this.addEvent(id, "operator", scheduledAt ? `Scheduled for ${scheduledAt}` : "Cleared start time; ready once prerequisites are met", { scheduledAt });
      return true;
    }).immediate();
  }

  /** The task's prerequisites in the order it lists them, and whether each has landed. */
  prerequisiteStates(task: Pick<Task, "prerequisites">): PrerequisiteState[] {
    return task.prerequisites.map((id) => {
      const t = this.getTask(id);
      // A prerequisite that's gone can never land; it holds the task until the operator waives it.
      return t ? { id: t.id, title: t.title, status: t.status, met: prerequisiteMet(t) } : { id, title: "Unknown task", status: "failed", met: false };
    });
  }

  /**
   * What the task's merged prerequisites in this repo put on the default branch:
   * the commits a checkout must contain, and tasks whose record names no commit
   * (merged before Crane kept one). Prerequisites finished without a branch left
   * nothing to find, and a waiver means the operator accepted them being missing.
   */
  prerequisiteCommits(task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt" | "repoId">): { commits: LandedCommit[]; unrecorded: string[] } {
    const commits: LandedCommit[] = [];
    const unrecorded: string[] = [];
    if (task.prerequisitesWaivedAt) return { commits, unrecorded };
    for (const id of task.prerequisites) {
      const t = this.getTask(id);
      if (t?.status !== "merged" || t.repoId !== task.repoId) continue;
      const outcome = lastMergeOutcome(this.listEvents(t.id));
      const commit = outcome?.commit ?? outcome?.head;
      if (commit) commits.push({ id: t.id, title: t.title, commit });
      else unrecorded.push(t.id);
    }
    return { commits, unrecorded };
  }

  /** Tasks started from this task's findings, oldest first. */
  followUps(taskId: string): FollowUpState[] {
    return (this.db
      .prepare("SELECT id, title, status, follow_up_finding FROM tasks WHERE follow_up_of = ? ORDER BY created_at, rowid")
      .all(taskId) as Row[])
      .map((r) => ({
        id: r.id as string,
        title: r.title as string,
        status: r.status as TaskStatus,
        finding: (r.follow_up_finding as number) ?? null,
      }));
  }

  /** The task and finding this one was started from, or null when it isn't a follow-up. */
  followUpSource(task: Pick<Task, "followUpOf" | "followUpFinding">): FollowUpSource | null {
    if (!task.followUpOf) return null;
    const t = this.getTask(task.followUpOf);
    if (!t) return { id: task.followUpOf, title: "Unknown task", status: "failed", finding: null };
    const finding = task.followUpFinding === null ? undefined : t.report?.findings[task.followUpFinding];
    return { id: t.id, title: t.title, status: t.status, finding: finding?.title ?? null };
  }

  /** Prerequisites still holding the task back: not landed, and not waived by the operator. */
  unmetPrerequisites(task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt">): PrerequisiteState[] {
    return task.prerequisitesWaivedAt ? [] : this.prerequisiteStates(task).filter((p) => !p.met);
  }

  /**
   * Let a queued task start without the prerequisites that haven't landed. One
   * conditional write, so it can't apply after the task has been picked up or
   * cancelled. Returns whether it applied.
   */
  waivePrerequisites(id: string): boolean {
    return this.db
      .prepare("UPDATE tasks SET prerequisites_waived_at = ? WHERE id = ? AND status = 'queued' AND prerequisites_waived_at IS NULL")
      .run(now(), id).changes > 0;
  }

  getTask(id: string): Task | null {
    // Accept a bare id too. Tasks created before the rename kept their `m-` prefix.
    const r = this.db
      .prepare("SELECT * FROM tasks WHERE id IN (?, ?, ?) ORDER BY id = ? DESC LIMIT 1")
      .get(id, `t-${id}`, `m-${id}`, id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  /**
   * Unassigned queued work that is no longer waiting for its start time. Post-mortems
   * count only while any active member can run them: activating someone else
   * wouldn't help one that's waiting for the crew the operator named.
   */
  queuedForAnyone(): number {
    const named = this.postmortemCrew().length ? "AND postmortem_of IS NULL" : "";
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND assignee IS NULL ${named} AND ${TASK_DUE}`)
      .get(now()) as { n: number }).n;
  }

  listTasks(opts: TaskListOptions = {}): Task[] {
    return this.taskListRows("t.*", opts).map(toTask);
  }

  /** Select only what polled rows display, without loading briefs or parsing full reports in JS. */
  listTaskSummaries(opts: TaskListOptions = {}): TaskSummary[] {
    return this.taskListRows<TaskSummary>(TASK_SUMMARY_COLUMNS, opts);
  }

  private taskListRows<T = Row>(columns: string, opts: TaskListOptions): T[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status?.length) {
      where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
      params.push(...opts.status);
    }
    if (opts.repoId) {
      where.push("repo_id = ?");
      params.push(opts.repoId);
    }
    if (opts.assignee) {
      where.push("assignee = ?");
      params.push(opts.assignee);
    }
    // Pick the page from the index first, so keeping a few tasks doesn't read every match's brief and report.
    const sql = `SELECT ${columns} FROM (
                   SELECT rowid AS page_rowid FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
                   ORDER BY created_at DESC, rowid DESC LIMIT ?
                 ) page
                 CROSS JOIN tasks t ON t.rowid = page.page_rowid
                 ORDER BY t.created_at DESC, t.rowid DESC`;
    params.push(opts.limit ?? 200);
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Tasks in one of these statuses that still have a worktree on record. */
  tasksWithWorktrees(statuses: TaskStatus[]): Task[] {
    if (!statuses.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE worktree IS NOT NULL AND status IN (${statuses.map(() => "?").join(",")})`)
      .all(...statuses) as Row[];
    return rows.map(toTask);
  }

  updateTask(id: string, patch: TaskPatch) {
    const cols: Readonly<Record<string, string>> = TASK_UPDATE_COLUMNS;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      params.push((k === "report" || k === "visualReview" || k === "reviewCheckpoint") && v ? JSON.stringify(v) : v);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  setStatus(id: string, status: TaskStatus, message?: string, data?: Record<string, unknown>) {
    const patch: TaskPatch = { status };
    if (status === "running") patch.startedAt = now();
    // Waiting on the operator counts as finished: the agent's part is over.
    if (status === "needs_review" || FINISHED_STATUSES.includes(status)) patch.finishedAt = now();
    this.updateTask(id, patch);
    this.addEvent(id, "status", message ?? status, { ...data, status });
  }

  /** Persist the successful merge and its follow-up together, including across restarts. */
  completeMerge(id: string, message: string, data: Record<string, unknown>): Task | null {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`Unknown task ${id}`);
      if (task.status === "merged") return null;
      if (task.status !== "merging") throw new Error(`Task ${id} isn't merging`);
      this.updateTask(id, { worktree: null });
      this.setStatus(id, "merged", message, data);
      const defaults = this.postmortemSettings();
      const review = this.createTask({
        kind: "maintenance",
        title: `Post-mortem: ${task.title}`,
        brief: postmortemBrief(task),
        repoId: task.repoId,
        autonomy: "observe",
        driver: defaults.driver ?? task.driver,
        driverSettings: defaults.driver ? { model: defaults.model, effort: defaults.effort } : null,
        postmortemOf: id,
      });
      this.addEvent(id, "note", "Queued a post-mortem to look for task friction", { postmortemTaskId: review.id });
      this.addEvent(review.id, "note", `Reviewing merged task ${id}`, { sourceTaskId: id });
      return review;
    }).immediate();
  }

  /** The brief a post-mortem's agent reviews, built from its merged task's current history. */
  postmortemPrompt(sourceTaskId: string): string {
    const source = this.getTask(sourceTaskId);
    return source ? postmortemPrompt(source, this.listEvents(source.id)) : postmortemSourceMissing(sourceTaskId);
  }

  /**
   * Pre-approve a task, or take that back, while it's still queued or running.
   * One conditional write, so it can't land after the run has already handed
   * the task to review. Returns whether it applied.
   */
  setPreApproval(id: string, on: boolean): boolean {
    return this.db
      .prepare(
        `UPDATE tasks SET pre_approved_at = ? WHERE id = ? AND status IN ('queued', 'running') AND autonomy != 'observe'`,
      )
      .run(on ? now() : null, id).changes > 0;
  }

  /** Record the candidate waiver authorized by the operator's task pre-approval. */
  waivePreApprovedVisualReview(id: string, candidate: VisualReview): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task?.preApprovedAt || task.autonomy === "observe") return false;
      const review: VisualReview = { ...candidate, status: "waived", decidedAt: now(),
        note: "Visual review waived by operator pre-approval for this task, including conflict resolutions. All views and viewport sizes may remain unreviewed." };
      this.updateTask(id, { visualReview: review });
      this.addEvent(id, "note", "Visual review waived by pre-approval", { preApprovedAt: task.preApprovedAt, visualReview: review });
      return true;
    }).immediate();
  }

  /**
   * Hand a task over once its work run passed: to review (`needs_review`), as
   * done, or, when the operator pre-approved it and it has a branch, straight to
   * the merge queue. One transaction, so a pre-approval or cancel racing the end
   * of the run either counts or doesn't. Returns the new status, or null if the
   * task was cancelled meanwhile.
   */
  finishWork(id: string, outcome: "needs_review" | "done"): TaskStatus | null {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task || task.status === "cancelled") return null;
      if (task.visualReview?.status === "pending") this.waivePreApprovedVisualReview(id, task.visualReview);
      const completionHold = completionReviewReason(task);
      if (completionHold) {
        this.setStatus(id, "needs_review", `Implementation requires operator review: ${completionHold}`, { completionHold });
        return "needs_review" as const;
      }
      // Completion alone doesn't satisfy separately requested acceptance criteria.
      const unmet = unmetAcceptance(task);
      if (task.preApprovedAt && task.branch && task.autonomy !== "observe" && unmet.length) {
        this.setStatus(id, "needs_review",
          `Pre-approved, but the report doesn't show ${unmet.length === 1 ? "an acceptance criterion" : `${unmet.length} acceptance criteria`} met. Ready for your review`,
          { acceptanceUnmet: unmet });
        return "needs_review" as const;
      }
      if (task.preApprovedAt && task.branch && task.autonomy !== "observe") {
        const main = (task.repoId && this.getRepo(task.repoId)?.defaultBranch) || "main";
        // Free for any agent to claim, and queued by when the work finished.
        this.updateTask(id, { agentId: null, finishedAt: now() });
        this.setStatus(id, "merging", `Checks passed. Waiting to merge into ${main}, as you pre-approved`, { preApproved: true });
        return "merging" as const;
      }
      this.setStatus(id, outcome, outcome === "needs_review" ? "Ready for your review" : "Done");
      return outcome;
    }).immediate();
  }

  /** Read-only hint for one tick; claims still recheck under the write lock. */
  pendingWork(): { queued: boolean; merging: boolean } {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM tasks WHERE status = 'queued' AND ${TASK_DUE}) AS queued,
      EXISTS(SELECT 1 FROM tasks WHERE status = 'merging' AND agent_id IS NULL) AS merging`)
      .get(now()) as { queued: number; merging: number };
    return { queued: !!row.queued, merging: !!row.merging };
  }

  /**
   * Atomically take the first queued task this agent may work: one assigned
   * to it, or one assigned to nobody unless `onlyAssigned`. Once the operator
   * names a post-mortem crew, post-mortems go to them alone, whatever their role;
   * `onlyPostmortems` is how a named member who's on-call gets called in. Skips tasks whose
   * start time hasn't arrived or prerequisites haven't landed (unless waived). Safe if two
   * factories race. Immediate because it reads, then writes: a deferred transaction
   * fails at once, without waiting for busy_timeout, if another process commits between them.
   */
  claimNextTask(agentId: string, opts: { onlyAssigned?: boolean; onlyPostmortems?: boolean } = {}): Task | null {
    const crew = this.postmortemCrew();
    const named = crew.includes(agentId);
    if (opts.onlyPostmortems && !named) return null;
    const mine = opts.onlyAssigned ? "assignee = ?" : "(assignee IS NULL OR assignee = ?)";
    const eligible = opts.onlyPostmortems ? "postmortem_of IS NOT NULL"
      : !crew.length ? mine
      : named ? `(postmortem_of IS NOT NULL OR ${mine})`
      : `(postmortem_of IS NULL AND ${mine})`;
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM tasks WHERE status = 'queued' AND ${eligible}
          AND ${TASK_DUE} ORDER BY queue_position, created_at, rowid`)
        .all(...(opts.onlyPostmortems ? [now()] : [agentId, now()])) as Row[];
      const next = rows.map(toTask).find((t) => !this.unmetPrerequisites(t).length);
      if (!next) return null;
      const changed = this.db
        .prepare("UPDATE tasks SET status = 'running', agent_id = ?, started_at = ? WHERE id = ? AND status = 'queued'")
        .run(agentId, now(), next.id).changes;
      if (!changed) return null;
      this.addEvent(next.id, "status", "Picked up", { status: "running", agentId });
      return this.getTask(next.id);
    }).immediate();
  }

  /**
   * Atomically take the oldest task waiting to merge. Skips repos that already
   * have a merge in progress, so two merges never race for the same branch.
   */
  claimNextMerge(agentId: string, busyRepoIds: string[] = []): Task | null {
    return this.db.transaction(() => {
      const skip = busyRepoIds.length ? `AND repo_id NOT IN (${busyRepoIds.map(() => "?").join(",")})` : "";
      const r = this.db
        .prepare(`SELECT id FROM tasks WHERE status = 'merging' AND agent_id IS NULL ${skip} ORDER BY finished_at ASC LIMIT 1`)
        .get(...busyRepoIds) as Row | undefined;
      if (!r) return null;
      const changed = this.db
        .prepare("UPDATE tasks SET agent_id = ? WHERE id = ? AND status = 'merging' AND agent_id IS NULL")
        .run(agentId, r.id).changes;
      if (!changed) return null;
      this.addEvent(r.id as string, "note", "Picked up to merge", { agentId });
      return this.getTask(r.id as string);
    }).immediate();
  }

  // ── events ────────────────────────────────────────────────
  addEvent(taskId: string, type: EventType, message: string, data?: Record<string, unknown> | null): TaskEvent {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, ?, ?, ?)")
      .run(taskId, ts, type, message, data ? JSON.stringify(data) : null);
    return { id: Number(info.lastInsertRowid), taskId, ts, type, message, data: data ?? null };
  }

  listEvents(taskId: string, afterId = 0): TaskEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC").all(taskId, afterId) as Row[]
    ).map(toEvent);
  }

  /** Latest lifecycle event per command, bounded for the next agent's prompt. */
  commandEvidence(taskId: string): CommandEvidence[] {
    const rows = this.db.prepare(`
      SELECT e.data FROM events e
      WHERE e.task_id = ? AND e.type = 'tool' AND json_extract(e.data, '$.command.commandId') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM events later WHERE later.task_id = e.task_id AND later.id > e.id
            AND json_extract(later.data, '$.command.commandId') = json_extract(e.data, '$.command.commandId')
        )
      ORDER BY e.id DESC LIMIT 40
    `).all(taskId) as Row[];
    return rows.reverse().map((r) => (JSON.parse(r.data as string) as { command: CommandEvidence }).command);
  }

  /** A lost stream is not proof that its command failed (or even stopped). */
  closeUnresolvedCommands(taskId?: string) {
    const rows = this.db.prepare(`
      SELECT e.task_id, e.data FROM events e
      WHERE e.type = 'tool' AND json_extract(e.data, '$.command.status') = 'running'
        AND (? IS NULL OR e.task_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM events later WHERE later.task_id = e.task_id AND later.id > e.id
            AND json_extract(later.data, '$.command.commandId') = json_extract(e.data, '$.command.commandId')
        )
    `).all(taskId ?? null, taskId ?? null) as Row[];
    for (const r of rows) {
      const command = (JSON.parse(r.data as string) as { command: CommandEvidence }).command;
      this.addEvent(r.task_id as string, "tool", "Command outcome unknown after the agent stream stopped", {
        tool: "shell", command: { ...command, status: "unknown", exitCode: null },
      });
    }
  }

  /** Events across every task, for the live factory feed. */
  eventsSince(afterId: number, limit = 200): TaskEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(afterId, limit) as Row[]).map(
      toEvent,
    );
  }

  latestEventId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM events").get() as Row;
    return (r.id as number) ?? 0;
  }

  // ── runs: what each agent run cost ────────────────────────
  startRun(input: { taskId: string; kind: RunKind; agentId: string | null; driver: string }): number {
    const info = this.db
      .prepare("INSERT INTO runs(task_id, kind, agent_id, driver, started_at) VALUES(?, ?, ?, ?, ?)")
      .run(input.taskId, input.kind, input.agentId, input.driver, now());
    return Number(info.lastInsertRowid);
  }

  /**
   * Close a run and add what it cost to its task, in one transaction so the
   * task's total always equals the sum of its runs. `usage` is null when the
   * run ended before its driver could say (e.g. it was killed).
   */
  finishRun(id: number, outcome: Exclude<RunOutcome, "running">, usage: RunUsage | null) {
    const u = usage ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, model: null };
    const cost = Number.isFinite(u.costUsd) && u.costUsd > 0 ? u.costUsd : 0;
    const costStatus = !usage || !Number.isFinite(u.costUsd) || u.costUsd < 0 ? "unknown" : u.costStatus ?? "reported";
    this.db.transaction(() => {
      const run = this.db
        .prepare(
          `UPDATE runs SET outcome = ?, finished_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
             cache_read_tokens = ?, cache_write_tokens = ?, turns = ?, model = COALESCE(?, model), cost_status = ?
           WHERE id = ? AND outcome = 'running' RETURNING task_id`,
        )
        .get(outcome, now(), cost, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.turns, u.model, costStatus, id) as
        | Row
        | undefined;
      // Already closed (say, by a restarted factory): don't count its cost twice.
      if (run && cost) this.db.prepare("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?").run(cost, run.task_id);
    })();
  }

  /** Runs a dead factory left open retain their unknown cost status. */
  closeStaleRuns(): number {
    return this.db.prepare("UPDATE runs SET outcome = 'cancelled', finished_at = ? WHERE outcome = 'running'").run(now()).changes;
  }

  listRuns(taskId: string): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC").all(taskId) as Row[]).map(toRun);
  }

  /** The driver of the task's latest work run, which owns its session. Null before its first run. */
  lastWorkDriver(taskId: string): string | null {
    const r = this.db
      .prepare("SELECT driver FROM runs WHERE task_id = ? AND kind = 'work' ORDER BY id DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return (r?.driver as string) ?? null;
  }

  /** Spend over the last `days` local days, today included, with the same span before it for comparison. */
  analytics(days = 30, nowMs = Date.now()): Analytics {
    days = Math.max(1, Math.min(366, Math.floor(days) || 30));
    const iso = (ms: number) => new Date(ms).toISOString();
    const from = localDayStart(nowMs, days - 1);
    const prevFrom = localDayStart(nowMs, 2 * days - 1);
    const rows = this.db
      .prepare(
        `SELECT r.task_id, r.driver, r.cost_usd, r.cost_status, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
                r.finished_at, t.title, t.status, t.kind, t.repo_id
         FROM runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.outcome != 'running' AND r.finished_at >= ?`,
      )
      .all(iso(prevFrom)) as Row[];

    const daily = new Map<number, { usd: number; runs: number }>();
    for (let i = days - 1; i >= 0; i--) daily.set(localDayStart(nowMs, i), { usd: 0, runs: 0 });
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    type TaskSpend = Analytics["topTasks"][number];
    const perTask = new Map<string, TaskSpend>();
    const perAgent = new Map<string, { usd: number; tasks: Set<string> }>();
    let spendUsd = 0;
    let prevSpendUsd = 0;
    let runs = 0;
    let unknownCostRuns = 0;

    for (const r of rows) {
      const at = Date.parse(r.finished_at as string);
      const usd = r.cost_usd as number;
      if (at < from) {
        prevSpendUsd += usd;
        continue;
      }
      spendUsd += usd;
      runs++;
      if (r.cost_status === "unknown") unknownCostRuns++;
      tokens.input += r.input_tokens as number;
      tokens.output += r.output_tokens as number;
      tokens.cacheRead += r.cache_read_tokens as number;
      tokens.cacheWrite += r.cache_write_tokens as number;
      const b = daily.get(localDayStart(at));
      if (b) {
        b.usd += usd;
        b.runs++;
      }
      const id = r.task_id as string;
      const driver = r.driver as string;
      const agent = perAgent.get(driver) ?? { usd: 0, tasks: new Set<string>() };
      agent.usd += usd;
      agent.tasks.add(id);
      perAgent.set(driver, agent);
      let t = perTask.get(id);
      if (!t) {
        t = {
          id,
          title: r.title as string,
          status: r.status as TaskStatus,
          kind: r.kind as TaskKind,
          repoId: (r.repo_id as string) ?? null,
          usd: 0,
          runs: 0,
        };
        perTask.set(id, t);
      }
      t.usd += usd;
      t.runs++;
    }

    const tasks = [...perTask.values()];
    const slice = (list: TaskSpend[]) => ({ usd: list.reduce((s, t) => s + t.usd, 0), tasks: list.length });
    const groupBy = <K extends string | null>(key: (t: TaskSpend) => K) => {
      const groups = new Map<K, TaskSpend[]>();
      for (const t of tasks) {
        if (t.usd > 0) {
          const k = key(t);
          const group = groups.get(k);
          if (group) group.push(t);
          else groups.set(k, [t]);
        }
      }
      return [...groups.entries()].map(([k, list]) => ({ key: k, ...slice(list) })).sort((a, b) => b.usd - a.usd);
    };
    const repoNames = new Map(this.listRepos().map((r) => [r.id, r.name]));

    return {
      days,
      from: iso(from),
      to: iso(nowMs),
      spendUsd,
      unknownCostRuns,
      prevSpendUsd,
      runs,
      tasks: tasks.length,
      shipped: slice(tasks.filter((t) => SHIPPED_STATUSES.includes(t.status))),
      unshipped: slice(tasks.filter((t) => UNSHIPPED_STATUSES.includes(t.status))),
      tokens,
      daily: [...daily.entries()].map(([t, v]) => ({ day: iso(t), ...v })),
      byRepo: groupBy((t) => t.repoId).map(({ key, ...s }) => ({
        repoId: key,
        name: key ? (repoNames.get(key) ?? "Disconnected repo") : "No repo",
        ...s,
      })),
      byKind: groupBy((t) => t.kind).map(({ key, ...s }) => ({ kind: key, ...s })),
      byAgent: [...perAgent].map(([driver, s]) => ({ driver, usd: s.usd, tasks: s.tasks.size }))
        .sort((a, b) => b.usd - a.usd || a.driver.localeCompare(b.driver)),
      topTasks: tasks
        .filter((t) => t.usd > 0)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 10),
    };
  }

  // ── agents ────────────────────────────────────────────────
  listAgents(): Agent[] {
    const postmortemCrew = this.postmortemCrew();
    return (this.db.prepare("SELECT * FROM agents ORDER BY name").all() as Row[]).map((r) => {
      const agent = toAgent(r);
      return {
        ...agent,
        active: this.crewActive(agent.id),
        defaultDriver: this.crewDefaultDriver(agent.id),
        role: this.crewRole(agent.id),
        runsPostmortems: postmortemCrew.includes(agent.id),
      };
    });
  }

  /**
   * Whether a crew member takes work. Members are active unless the operator put
   * them on-call, where they take only the post-mortems they're named for.
   */
  crewActive(agentId: string): boolean {
    return this.getSetting(crewSettingKey.active(agentId)) !== "false";
  }

  /** The agent a crew member prefers to run on, or null to follow the factory's default. */
  crewDefaultDriver(agentId: string): string | null {
    return this.getSetting(crewSettingKey.defaultDriver(agentId)) || null;
  }

  /** The maintenance a crew member is dedicated to, or null for a general member. */
  crewRole(agentId: string): MaintenanceRole | null {
    const role = this.getSetting(crewSettingKey.role(agentId));
    return isMaintenanceRole(role) ? role : null;
  }

  upsertAgent(a: Pick<Agent, "id" | "name" | "driver">) {
    this.db
      .prepare(
        `INSERT INTO agents(id, name, driver) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, driver = excluded.driver`,
      )
      .run(a.id, a.name, a.driver);
  }

  setAgentState(id: string, state: AgentState, taskId: string | null) {
    this.db
      .prepare(`UPDATE agents SET state = ?, task_id = ?, last_active_at =
        CASE WHEN state = 'working' OR ? = 'working' THEN ? ELSE last_active_at END
        WHERE id = ? AND (state IS NOT ? OR task_id IS NOT ?)`)
      .run(state, taskId, state, now(), id, state, taskId);
  }

  /** Which agent a crew member is running on right now. It changes with each task's choice. */
  setAgentDriver(id: string, driver: string) {
    this.db.prepare("UPDATE agents SET driver = ? WHERE id = ?").run(driver, id);
  }

  bumpAgentCompleted(id: string) {
    this.db.prepare("UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE id = ?").run(id);
  }

  /** Remove agents outside the current crew, keeping any that are still working. */
  pruneAgents(keepIds: string[]) {
    if (!keepIds.length) return;
    this.db
      .prepare(`DELETE FROM agents WHERE id NOT IN (${keepIds.map(() => "?").join(",")}) AND state != 'working'`)
      .run(...keepIds);
  }

  // ── overview ──────────────────────────────────────────────
  overview(factory: Overview["factory"]): Overview {
    const counts = Object.fromEntries(
      ALL_STATUSES.map((s) => [s, 0]),
    ) as Overview["counts"];
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Row[]) {
      counts[r.status as TaskStatus] = r.n as number;
    }

    const weekMs = 7 * 24 * 3600 * 1000;
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const shippedIn = SHIPPED_STATUSES.map((s) => `'${s}'`).join(",");
    const shipped = (from: number, to: number) =>
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ? AND finished_at < ?`,
          )
          .get(iso(from), iso(to)) as Row
      ).n as number;

    // Counted when the money was spent, not when the task was created.
    const spend = (
      this.db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE outcome != 'running' AND finished_at >= ?")
        .get(iso(t0 - weekMs)) as Row
    ).s as number;

    // Hourly activity buckets for the last 7 days.
    const hour = 3600 * 1000;
    const start = Math.floor((t0 - weekMs) / hour) * hour;
    // Stored times are all UTC toISOString(), so "2026-11-02T14" names an hour, in SQL as well as here.
    const hourOf = (ms: number) => iso(ms).slice(0, 13);
    const buckets = new Map<string, { t: string; done: number; events: number }>();
    for (let t = start; t <= t0; t += hour) buckets.set(hourOf(t), { t: iso(t), done: 0, events: 0 });
    for (const r of this.db
      .prepare(
        "SELECT substr(ts, 1, 13) AS hour, COUNT(*) AS n FROM events WHERE ts >= ? AND type IN ('note','tool','finding') GROUP BY hour",
      )
      .all(iso(start)) as Row[]) {
      const b = buckets.get(r.hour as string);
      if (b) b.events = r.n as number;
    }
    for (const r of this.db
      .prepare(
        `SELECT substr(finished_at, 1, 13) AS hour, COUNT(*) AS n FROM tasks WHERE status IN (${shippedIn}) AND finished_at >= ? GROUP BY hour`,
      )
      .all(iso(start)) as Row[]) {
      const b = buckets.get(r.hour as string);
      if (b) b.done = r.n as number;
    }

    const openByRepo = new Map<string, number>();
    for (const r of this.db
      .prepare(
        "SELECT repo_id, COUNT(*) AS n FROM tasks WHERE status IN ('queued','running','needs_review','merging') GROUP BY repo_id",
      )
      .all() as Row[]) {
      openByRepo.set(r.repo_id as string, r.n as number);
    }

    return {
      factory,
      counts,
      queuedForAnyone: this.queuedForAnyone(),
      shippedThisWeek: shipped(t0 - weekMs, t0 + 1),
      shippedLastWeek: shipped(t0 - 2 * weekMs, t0 - weekMs),
      spendThisWeekUsd: spend,
      activity: [...buckets.values()],
      needsReview: this.listTaskSummaries({ status: ["needs_review"], limit: 20 }),
      goalsNeedingReview: this.listGoalSummaries(true),
      inFlight: this.listTaskSummaries({ status: ACTIVE_STATUSES, limit: 20 }),
      recent: this.listTaskSummaries({ status: FINISHED_STATUSES, limit: 8 }),
      agents: this.listAgents(),
      repos: this.listRepos().map((r) => ({ ...r, openTasks: openByRepo.get(r.id) ?? 0, tools: this.repoTools(r.id) })),
      // One refusal could be a fluke; the same one in a second task is a pattern worth a decision.
      blocked: this.blockedTools({ minTasks: 2 }).slice(0, 5),
    };
  }
}
