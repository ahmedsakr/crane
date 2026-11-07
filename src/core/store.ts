import Database from "better-sqlite3";
import { dbPath } from "./paths.js";
import { isEmptyDatabase, migrate } from "./store/migrations.js";
import { analytics } from "./store/analytics.js";
import { overview } from "./store/overview.js";
import { BlockedToolsReader } from "./store/blocked-tools.js";
import { AccessStore } from "./store/access.js";
import { approveGoal, cancelGoal, createGoal, getGoal, goalDetail, goalForTask, listGoals, listGoalSummaries,
  retryGoalTask, reviseGoal, saveGoalPlan, syncGoals, type NewGoal } from "./store/goals.js";
import { goalListItems } from "./store/goal-progress.js";
import { createTask, getTask, listTasks, listTaskSummaries, setStatus, tasksWithWorktrees, updateTask,
  type NewTaskRecord, type TaskListOptions, type TaskPatch } from "./store/tasks.js";
import { listQueuedTasks, listQueuedTaskSummaries, moveQueuedTask, queuedForAnyone, setTaskAgent, setTaskSchedule,
  type TaskAgent } from "./store/queue.js";
import { followUps, followUpSource, prerequisiteCommits, prerequisiteStates, unmetPrerequisites, waivePrerequisites,
  type LandedCommit } from "./store/prerequisites.js";
import { completeMerge, finishWork, postmortemPrompt, setPreApproval, waivePreApprovedVisualReview } from "./store/review.js";
import { claimNextMerge, claimNextTask, pendingWork, type ClaimOptions } from "./store/claims.js";
import { addEvent, closeUnresolvedCommands, commandEvidence, eventsSince, latestEventId, listEvents } from "./store/events.js";
import { closeStaleRuns, finishRun, hasRunningRun, lastWorkDriver, listRuns, startRun } from "./store/runs.js";
import { getSetting, isPaused, postmortemCrew, postmortemSettings, pruneTaskHistory, retentionSettings, setPaused,
  setPostmortemSettings, setSetting, vacuumHistory } from "./store/settings.js";
import { addRepo, getRepo, listRepos, removeRepo, repoChecks, repoTools, setRepoChecks, setRepoTools,
  type NewRepo } from "./store/repos.js";
import { bumpAgentCompleted, crewActive, crewDefaultDriver, crewRole, listAgents, pruneAgents, setAgentDriver,
  setAgentState, upsertAgent } from "./store/crew.js";
import { claimCrewSchedule, crewScheduleOutcome, listCrewSchedules, removeCrewSchedule,
  saveCrewSchedule } from "./store/crew-schedules.js";
import type {
  Agent,
  AgentRun,
  AgentState,
  Analytics,
  BlockedTool,
  CommandEvidence,
  CrewSchedule,
  CrewScheduleInput,
  EventType,
  FollowUpSource,
  FollowUpState,
  Goal,
  GoalDetail,
  GoalListItem,
  GoalPlan,
  GoalSummary,
  MaintenanceRole,
  NewTask,
  Overview,
  PostmortemSettings,
  PrerequisiteState,
  Repo,
  RepoTools,
  RetentionSettings,
  RunKind,
  RunOutcome,
  RunUsage,
  Task,
  TaskEvent,
  TaskStatus,
  TaskSummary,
  VisualReview,
} from "@crane/contracts";

export type { LandedCommit } from "./store/prerequisites.js";
export { crewSettingKey } from "./store/crew.js";

/**
 * The single source of truth. Every process (the factory server, the CLI)
 * opens the same SQLite file in WAL mode, so the CLI works whether or not
 * the factory is running, and live views just tail the events table.
 * Each domain lives in store/; these methods only delegate to it. Operators,
 * sessions and invites are reached through `access` instead of delegates.
 */
export class Store {
  readonly db: Database.Database;
  readonly access: AccessStore;
  private readonly blockedToolsReader = new BlockedToolsReader();

  constructor(file = dbPath()) {
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    // This is cheap before the first schema is created. Existing databases are
    // converted by opt-in maintenance, never by an ordinary CLI/store open.
    if (isEmptyDatabase(this.db)) this.db.pragma("auto_vacuum = INCREMENTAL");
    this.db.pragma("journal_mode = WAL");
    migrate(this.db);
    this.access = new AccessStore(this.db);
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

  /** The Goals page's rows, with each goal's progress. */
  goalListItems(): GoalListItem[] {
    return goalListItems(this);
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

  // Crew schedules live in store/crew-schedules.ts.
  listCrewSchedules(agentId?: string): CrewSchedule[] {
    return listCrewSchedules(this, agentId);
  }

  saveCrewSchedule(id: string, agentId: string, input: CrewScheduleInput, nextFireAt: string): CrewSchedule {
    return saveCrewSchedule(this, id, agentId, input, nextFireAt);
  }

  removeCrewSchedule(id: string): void {
    removeCrewSchedule(this, id);
  }

  /** Must run inside the same transaction as task creation and outcome recording. */
  claimCrewSchedule(s: CrewSchedule, next: string, firedAt: string): boolean {
    return claimCrewSchedule(this, s, next, firedAt);
  }

  crewScheduleOutcome(id: string, outcome: string): void {
    crewScheduleOutcome(this, id, outcome);
  }

  // Settings, pause state, retention and post-mortem choices live in store/settings.ts.
  getSetting(key: string): string | null {
    return getSetting(this, key);
  }

  setSetting(key: string, value: string) {
    setSetting(this, key, value);
  }

  retentionSettings(): RetentionSettings {
    return retentionSettings(this);
  }

  pruneTaskHistory(cutoff: string, days: number): number {
    return pruneTaskHistory(this, cutoff, days);
  }

  vacuumHistory(): void {
    vacuumHistory(this);
  }

  postmortemSettings(): PostmortemSettings {
    return postmortemSettings(this);
  }

  postmortemCrew(): string[] {
    return postmortemCrew(this);
  }

  setPostmortemSettings(settings: PostmortemSettings) {
    setPostmortemSettings(this, settings);
  }

  isPaused(): boolean {
    return isPaused(this);
  }

  setPaused(paused: boolean) {
    setPaused(this, paused);
  }

  // Repos, their tool rules and checks live in store/repos.ts.
  listRepos(): Repo[] {
    return listRepos(this);
  }

  getRepo(idOrName: string): Repo | null {
    return getRepo(this, idOrName);
  }

  addRepo(input: NewRepo): Repo {
    return addRepo(this, input);
  }

  removeRepo(id: string) {
    removeRepo(this, id);
  }

  repoTools(repoId: string): RepoTools {
    return repoTools(this, repoId);
  }

  repoChecks(repoId: string): string[] {
    return repoChecks(this, repoId);
  }

  setRepoChecks(repoId: string, commands: string[]) {
    setRepoChecks(this, repoId, commands);
  }

  setRepoTools(repoId: string, tools: RepoTools) {
    setRepoTools(this, repoId, tools);
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

  hasRunningRun(taskId: string): boolean {
    return hasRunningRun(this, taskId);
  }

  /** Spend over the last `days` local days, today included, with the same span before it for comparison. */
  analytics(days = 30, nowMs = Date.now()): Analytics {
    return analytics(this, days, nowMs);
  }

  // Crew members and their settings live in store/crew.ts.
  listAgents(): Agent[] {
    return listAgents(this);
  }

  crewActive(agentId: string): boolean {
    return crewActive(this, agentId);
  }

  crewDefaultDriver(agentId: string): string | null {
    return crewDefaultDriver(this, agentId);
  }

  crewRole(agentId: string): MaintenanceRole | null {
    return crewRole(this, agentId);
  }

  upsertAgent(a: Pick<Agent, "id" | "name" | "driver">) {
    upsertAgent(this, a);
  }

  setAgentState(id: string, state: AgentState, taskId: string | null) {
    setAgentState(this, id, state, taskId);
  }

  setAgentDriver(id: string, driver: string) {
    setAgentDriver(this, id, driver);
  }

  bumpAgentCompleted(id: string) {
    bumpAgentCompleted(this, id);
  }

  pruneAgents(keepIds: string[]) {
    pruneAgents(this, keepIds);
  }

  overview(factory: Overview["factory"]): Overview {
    return overview(this, factory);
  }
}
