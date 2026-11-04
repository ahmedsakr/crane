import Database from "better-sqlite3";
import { basename } from "node:path";
import { dbPath } from "./paths.js";
import { shortId } from "./ids.js";
import { SCHEMA } from "./store/schema.js";
import { addMissingColumns, migrateMissionsToTasks, migrateFollowUpLinks, migratePostmortemLinks,
  migratePostmortemBriefs, migrateCostsToRuns, migrateCostStatus } from "./store/migrations.js";
import { toRepo, toAgent, type Row } from "./store/rows.js";
import { analytics } from "./store/analytics.js";
import { overview } from "./store/overview.js";
import { BlockedToolsReader } from "./store/blocked-tools.js";
import { approveGoal, cancelGoal, createGoal, getGoal, goalDetail, goalForTask, listGoals, listGoalSummaries,
  retryGoalTask, reviseGoal, saveGoalPlan, syncGoals, type NewGoal } from "./store/goals.js";
import { createTask, getTask, listTasks, listTaskSummaries, setStatus, tasksWithWorktrees, updateTask,
  type NewTaskRecord, type TaskListOptions, type TaskPatch } from "./store/tasks.js";
import { listQueuedTasks, listQueuedTaskSummaries, moveQueuedTask, queuedForAnyone, setTaskAgent, setTaskSchedule,
  type TaskAgent } from "./store/queue.js";
import { followUps, followUpSource, prerequisiteCommits, prerequisiteStates, unmetPrerequisites, waivePrerequisites,
  type LandedCommit } from "./store/prerequisites.js";
import { completeMerge, finishWork, postmortemPrompt, setPreApproval, waivePreApprovedVisualReview } from "./store/review.js";
import { claimNextMerge, claimNextTask, pendingWork, type ClaimOptions } from "./store/claims.js";
import { addEvent, closeUnresolvedCommands, commandEvidence, eventsSince, latestEventId, listEvents } from "./store/events.js";
import { closeStaleRuns, finishRun, lastWorkDriver, listRuns, startRun } from "./store/runs.js";
import { now } from "./store/shared.js";
import {
  FINISHED_STATUSES,
  isMaintenanceRole,
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
import type {
  Agent,
  AgentRun,
  AgentState,
  Analytics,
  BlockedTool,
  RunKind,
  RunOutcome,
  RunUsage,
  EventType,
  RepoTools,
  Task,
  TaskSummary,
  TaskEvent,
  TaskStatus,
  NewTask,
  Overview,
  Repo,
  PostmortemSettings,
  RetentionSettings,
} from "@crane/contracts";

export type { LandedCommit } from "./store/prerequisites.js";

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
  private readonly blockedToolsReader = new BlockedToolsReader();

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

  // Goal persistence and workflow live in store/goals.ts.
  getGoal(id: string): Goal | null {
    return getGoal(this, id);
  }

  listGoals(): Goal[] {
    return listGoals(this);
  }

  listGoalSummaries(needsReview = false): GoalSummary[] {
    return listGoalSummaries(this, needsReview);
  }

  goalDetail(id: string): GoalDetail {
    return goalDetail(this, id);
  }

  goalForTask(taskId: string): string | null {
    return goalForTask(this, taskId);
  }

  createGoal(input: NewGoal, researchTask: NewTask): Goal {
    return createGoal(this, input, researchTask);
  }

  reviseGoal(id: string, revision: unknown, feedback: string, researchTask: NewTask): Goal {
    return reviseGoal(this, id, revision, feedback, researchTask);
  }

  saveGoalPlan(id: string, revision: unknown, plan: GoalPlan): Goal {
    return saveGoalPlan(this, id, revision, plan);
  }

  approveGoal(id: string, revision: unknown, autoMerge: boolean): Goal {
    return approveGoal(this, id, revision, autoMerge);
  }

  cancelGoal(id: string, revision: unknown): Goal {
    return cancelGoal(this, id, revision);
  }

  syncGoals(): void {
    syncGoals(this);
  }

  retryGoalTask(id: string, revision: unknown, taskId: string, retry: () => Task): Goal {
    return retryGoalTask(this, id, revision, taskId, retry);
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

  /** Rules agents were refused, excluding the repo's existing decisions. */
  blockedTools(opts: { repoId?: string; taskId?: string; minTasks?: number } = {}): BlockedTool[] {
    return this.blockedToolsReader.read(this.db, (id) => this.repoTools(id), opts);
  }

  // Task records live in store/tasks.ts.
  createTask(input: NewTaskRecord): Task {
    return createTask(this, input);
  }

  getTask(id: string): Task | null {
    return getTask(this, id);
  }

  listTasks(opts: TaskListOptions = {}): Task[] {
    return listTasks(this, opts);
  }

  listTaskSummaries(opts: TaskListOptions = {}): TaskSummary[] {
    return listTaskSummaries(this, opts);
  }

  tasksWithWorktrees(statuses: TaskStatus[]): Task[] {
    return tasksWithWorktrees(this, statuses);
  }

  updateTask(id: string, patch: TaskPatch) {
    updateTask(this, id, patch);
  }

  setStatus(id: string, status: TaskStatus, message?: string, data?: Record<string, unknown>) {
    setStatus(this, id, status, message, data);
  }

  // Queue order and scheduling live in store/queue.ts.
  listQueuedTasks(): Task[] {
    return listQueuedTasks(this);
  }

  listQueuedTaskSummaries(): TaskSummary[] {
    return listQueuedTaskSummaries(this);
  }

  moveQueuedTask(id: string, beforeId: string | null): Task[] {
    return moveQueuedTask(this, id, beforeId);
  }

  setTaskSchedule(id: string, scheduledAt: string | null): boolean {
    return setTaskSchedule(this, id, scheduledAt);
  }

  setTaskAgent(id: string, run: TaskAgent, message: string): boolean {
    return setTaskAgent(this, id, run, message);
  }

  queuedForAnyone(): number {
    return queuedForAnyone(this);
  }

  // Prerequisites and follow-ups live in store/prerequisites.ts.
  prerequisiteStates(task: Pick<Task, "prerequisites">): PrerequisiteState[] {
    return prerequisiteStates(this, task);
  }

  prerequisiteCommits(task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt" | "repoId">): { commits: LandedCommit[]; unrecorded: string[] } {
    return prerequisiteCommits(this, task);
  }

  unmetPrerequisites(task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt">): PrerequisiteState[] {
    return unmetPrerequisites(this, task);
  }

  waivePrerequisites(id: string): boolean {
    return waivePrerequisites(this, id);
  }

  followUps(taskId: string): FollowUpState[] {
    return followUps(this, taskId);
  }

  followUpSource(task: Pick<Task, "followUpOf" | "followUpFinding">): FollowUpSource | null {
    return followUpSource(this, task);
  }

  // Pre-approval and the hand-offs out of a work run or merge live in store/review.ts.
  setPreApproval(id: string, on: boolean): boolean {
    return setPreApproval(this, id, on);
  }

  waivePreApprovedVisualReview(id: string, candidate: VisualReview): boolean {
    return waivePreApprovedVisualReview(this, id, candidate);
  }

  finishWork(id: string, outcome: "needs_review" | "done"): TaskStatus | null {
    return finishWork(this, id, outcome);
  }

  completeMerge(id: string, message: string, data: Record<string, unknown>): Task | null {
    return completeMerge(this, id, message, data);
  }

  postmortemPrompt(sourceTaskId: string): string {
    return postmortemPrompt(this, sourceTaskId);
  }

  // Atomic claims live in store/claims.ts.
  pendingWork(): { queued: boolean; merging: boolean } {
    return pendingWork(this);
  }

  claimNextTask(agentId: string, opts: ClaimOptions = {}): Task | null {
    return claimNextTask(this, agentId, opts);
  }

  claimNextMerge(agentId: string, busyRepoIds: string[] = []): Task | null {
    return claimNextMerge(this, agentId, busyRepoIds);
  }

  // Events and command evidence live in store/events.ts.
  addEvent(taskId: string, type: EventType, message: string, data?: Record<string, unknown> | null): TaskEvent {
    return addEvent(this, taskId, type, message, data);
  }

  listEvents(taskId: string, afterId = 0): TaskEvent[] {
    return listEvents(this, taskId, afterId);
  }

  commandEvidence(taskId: string): CommandEvidence[] {
    return commandEvidence(this, taskId);
  }

  closeUnresolvedCommands(taskId?: string) {
    closeUnresolvedCommands(this, taskId);
  }

  eventsSince(afterId: number, limit = 200): TaskEvent[] {
    return eventsSince(this, afterId, limit);
  }

  latestEventId(): number {
    return latestEventId(this);
  }

  // Runs and what they cost live in store/runs.ts.
  startRun(input: { taskId: string; kind: RunKind; agentId: string | null; driver: string }): number {
    return startRun(this, input);
  }

  finishRun(id: number, outcome: Exclude<RunOutcome, "running">, usage: RunUsage | null) {
    finishRun(this, id, outcome, usage);
  }

  closeStaleRuns(): number {
    return closeStaleRuns(this);
  }

  listRuns(taskId: string): AgentRun[] {
    return listRuns(this, taskId);
  }

  lastWorkDriver(taskId: string): string | null {
    return lastWorkDriver(this, taskId);
  }

  /** Spend over the last `days` local days, today included, with the same span before it for comparison. */
  analytics(days = 30, nowMs = Date.now()): Analytics {
    return analytics(this, days, nowMs);
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
    return overview(this, factory);
  }
}
