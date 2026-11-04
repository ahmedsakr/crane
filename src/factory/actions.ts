import type {
  CrewSchedule,
  CrewScheduleInput,
  DriverInfo,
  Goal,
  NewGoal,
  NewTask,
  PostmortemSettings,
  Repo,
  RepoTools,
  RetentionSettings,
  RoleRunOptions,
  Task,
  TaskGates,
  TaskRunOptions,
} from "@crane/contracts";
import type { Store } from "../core/store.js";
import * as crew from "./actions/crew.js";
import * as drivers from "./actions/drivers.js";
import * as goals from "./actions/goals.js";
import * as permissions from "./actions/permissions.js";
import * as repos from "./actions/repos.js";
import * as review from "./actions/review.js";
import * as schedules from "./actions/schedules.js";
import * as settings from "./actions/settings.js";
import * as tasks from "./actions/tasks.js";

export { checkLookouts, checkScheduledAt, toRule } from "./action-inputs.js";

/**
 * Everything an operator can do, shared by the web UI and the CLI so both
 * behave identically. Task decisions record an `operator` event on the task.
 * This is the single public entry: each domain's rules live in `./actions/`.
 */
export class OperatorActions {
  constructor(private store: Store) {}

  // Goals

  createGoal(input: NewGoal): Goal {
    return goals.createGoal(this.store, input);
  }

  reviseGoal(id: string, revision: unknown, feedback: unknown): Goal {
    return goals.reviseGoal(this.store, id, revision, feedback);
  }

  editGoalPlan(id: string, revision: unknown, input: unknown): Goal {
    return goals.editGoalPlan(this.store, id, revision, input);
  }

  approveGoal(id: string, revision: unknown, autoMerge: unknown = false): Goal {
    return goals.approveGoal(this.store, id, revision, autoMerge);
  }

  cancelGoal(id: string, revision: unknown): Goal {
    return this.store.cancelGoal(id, revision);
  }

  retryGoalTask(id: string, revision: unknown, taskId: string, opts: TaskRunOptions = {}): Goal {
    return goals.retryGoalTask(this.store, id, revision, taskId, opts);
  }

  changeGoalPlanAgent(id: string, revision: unknown, key: string, input: TaskRunOptions): Goal {
    return goals.changeGoalPlanAgent(this.store, id, revision, key, input);
  }

  // Repos

  ensureFactoryRepo(): Promise<Repo | null> {
    return repos.ensureFactoryRepo(this.store);
  }

  connectRepo(path: string, name?: string): Promise<Repo> {
    return repos.connectRepo(this.store, path, name);
  }

  removeRepo(id: string): void {
    repos.removeRepo(this.store, id);
  }

  configureChecks(repoId: string, input: unknown): string[] {
    return repos.configureChecks(this.store, repoId, input);
  }

  // Tasks

  createTask(input: NewTask & { scheduleId?: string }): Task {
    return tasks.createTask(this.store, input);
  }

  moveQueuedTask(id: string, beforeId: unknown): Task[] {
    return tasks.moveQueuedTask(this.store, id, beforeId);
  }

  schedule(id: string, scheduledAt: unknown): Task {
    return tasks.schedule(this.store, id, scheduledAt);
  }

  changeAgent(id: string, input: TaskRunOptions): Task {
    return tasks.changeAgent(this.store, id, input);
  }

  waivePrerequisites(id: string, note?: string): Task {
    return tasks.waivePrerequisites(this.store, id, note);
  }

  cancel(id: string): Task {
    return tasks.cancel(this.store, id);
  }

  retry(id: string, opts: { driver?: string | null } = {}): Task {
    return tasks.retry(this.store, id, opts);
  }

  followUp(id: string, findingIndex: number, opts: TaskRunOptions & TaskGates & Pick<NewTask, "lookouts"> = {}): Task {
    return tasks.followUp(this.store, id, findingIndex, opts);
  }

  // Review and merge

  recordVisualReview(id: string, input: { status: "inspected" | "waived"; commit: string; note: string }): Promise<Task> {
    return review.recordVisualReview(this.store, id, input);
  }

  approve(id: string, note?: string, opts: { merge?: boolean } = {}): Promise<Task> {
    return review.approve(this.store, id, note, opts);
  }

  preApprove(id: string, note?: string): Task {
    return review.preApprove(this.store, id, note);
  }

  undoPreApproval(id: string): Task {
    return review.undoPreApproval(this.store, id);
  }

  merge(id: string): Promise<Task> {
    return review.merge(this.store, id);
  }

  reject(id: string, note?: string): Promise<Task> {
    return review.reject(this.store, id, note);
  }

  // Agents

  drivers(): Promise<DriverInfo[]> {
    return drivers.listDrivers(this.store);
  }

  configureDriver(name: string, input: { model?: string | null; effort?: string | null }): Promise<DriverInfo[]> {
    return drivers.configureDriver(this.store, name, input);
  }

  setDefaultDriver(name: string): Promise<DriverInfo[]> {
    return drivers.setDefaultDriver(this.store, name);
  }

  // Factory settings

  postmortemSettings(): PostmortemSettings {
    return this.store.postmortemSettings();
  }

  configurePostmortem(input: { driver?: string | null; model?: string | null; effort?: string | null; crew?: string[] }): PostmortemSettings {
    return settings.configurePostmortem(this.store, input);
  }

  retentionSettings(): RetentionSettings {
    return this.store.retentionSettings();
  }

  configureRetention(input: RetentionSettings): RetentionSettings {
    return settings.configureRetention(this.store, input);
  }

  pause() {
    this.store.setPaused(true);
  }

  resume() {
    this.store.setPaused(false);
  }

  // Crew

  configureCrew(id: string, input: { active?: boolean; defaultDriver?: string | null; role?: string | null }) {
    return crew.configureCrew(this.store, id, input);
  }

  runRole(id: string, opts: RoleRunOptions & { preApprove?: boolean; scheduleId?: string } = {}): Promise<Task> {
    return crew.runRole(this.store, id, opts);
  }

  // Crew schedules

  listCrewSchedules(agentId?: string): CrewSchedule[] {
    return schedules.listCrewSchedules(this.store, agentId);
  }

  saveCrewSchedule(agentId: string, input: CrewScheduleInput, id?: string): CrewSchedule {
    return schedules.saveCrewSchedule(this.store, agentId, input, id);
  }

  removeCrewSchedule(agentId: string, id: string): void {
    schedules.removeCrewSchedule(this.store, agentId, id);
  }

  fireCrewSchedules(at = Date.now()): void {
    schedules.fireCrewSchedules(this.store, at);
  }

  // Tool permissions

  allowTool(repoId: string, input: string, taskId?: string): RepoTools {
    return permissions.allowTool(this.store, repoId, input, taskId);
  }

  keepBlocked(repoId: string, input: string, taskId?: string): RepoTools {
    return permissions.keepBlocked(this.store, repoId, input, taskId);
  }

  disallowTool(repoId: string, input: string): RepoTools {
    return permissions.disallowTool(this.store, repoId, input);
  }
}
