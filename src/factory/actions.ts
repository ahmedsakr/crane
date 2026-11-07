import type {
  AuthStatus,
  EventActor,
  InviteCheck,
  InviteSummary,
  OperatorProfile,
  OperatorSession,
  OperatorSummary,
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
import type { SessionListing } from "../core/store/access.js";
import { generatePassword } from "./auth-crypto.js";
import * as access from "./actions/access.js";
import * as invites from "./actions/access-invites.js";
import type { AccessDeps } from "./actions/access-rules.js";
import * as sessions from "./actions/access-sessions.js";
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
export { AccessError } from "./actions/access-errors.js";
export type { Authenticated, SignedIn } from "./actions/access-sessions.js";
export type { AcceptInput, IssuedInvite } from "./actions/access-invites.js";

/**
 * Everything an operator can do, shared by the web UI and the CLI so both
 * behave identically. Task decisions record an `operator` event on the task.
 * This is the single public entry: each domain's rules live in `./actions/`.
 * `clock` is when access actions think it is; tests move it to reach expiry.
 */
export class OperatorActions {
  private readonly access: AccessDeps;

  constructor(private store: Store, clock: () => number = Date.now) {
    this.access = { store, now: clock };
  }

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

  // Sign-in and own account. `token` is the device's session token.

  authStatus(token: unknown, opts: { exposed: boolean }): AuthStatus {
    return sessions.authStatus(this.access, token, opts);
  }

  signIn(username: unknown, password: unknown, opts: { client?: unknown } = {}): Promise<sessions.SignedIn> {
    return sessions.signIn(this.access, username, password, opts);
  }

  authenticate(token: unknown): sessions.Authenticated | null {
    return sessions.authenticate(this.access, token);
  }

  signOut(token: unknown): void {
    sessions.signOut(this.access, token);
  }

  listMySessions(token: unknown): OperatorSession[] {
    return sessions.listMySessions(this.access, token);
  }

  signOutMySession(token: unknown, id: string): void {
    sessions.signOutMySession(this.access, token, id);
  }

  signOutMyOtherSessions(token: unknown): number {
    return sessions.signOutMyOtherSessions(this.access, token);
  }

  changeMyPassword(token: unknown, current: unknown, next: unknown): Promise<OperatorProfile> {
    return sessions.changeMyPassword(this.access, token, current, next);
  }

  renameMe(token: unknown, name: unknown): OperatorProfile {
    return sessions.renameMe(this.access, token, name);
  }

  // Invites and reset links

  inviteOperator(by: EventActor, input: { role: unknown; name?: unknown }): invites.IssuedInvite {
    return invites.inviteOperator(this.access, by, input);
  }

  listInvites(by: EventActor): InviteSummary[] {
    return invites.listInvites(this.access, by);
  }

  revokeInvite(by: EventActor, id: string): void {
    invites.revokeInvite(this.access, by, id);
  }

  checkInvite(token: unknown): InviteCheck {
    return invites.checkInvite(this.access, token);
  }

  acceptInvite(token: unknown, input: invites.AcceptInput, opts: { client?: unknown } = {}): Promise<sessions.SignedIn> {
    return invites.acceptInvite(this.access, token, input, opts);
  }

  createPasswordReset(by: EventActor, operatorId: string): invites.IssuedInvite {
    return invites.createPasswordReset(this.access, by, operatorId);
  }

  // Operators. The host counts as an admin; some actions are host-only.

  addOperator(by: EventActor, input: access.NewOperatorInput): Promise<OperatorProfile> {
    return access.addOperator(this.access, by, input);
  }

  /** A random password for `crane operators add --generate`; nothing keeps it. */
  generatePassword(): string {
    return generatePassword();
  }

  listOperators(): OperatorSummary[] {
    return access.listOperators(this.access);
  }

  setOperatorPassword(by: EventActor, operatorId: string, password: unknown): Promise<OperatorProfile> {
    return access.setOperatorPassword(this.access, by, operatorId, password);
  }

  setOperatorRole(by: EventActor, id: string, role: unknown): OperatorProfile {
    return access.setOperatorRole(this.access, by, id, role);
  }

  removeOperator(by: EventActor, id: string): void {
    access.removeOperator(this.access, by, id);
  }

  signOutOperator(by: EventActor, id: string): number {
    return access.signOutOperator(this.access, by, id);
  }

  listAllSessions(by: EventActor): SessionListing[] {
    return access.listAllSessions(this.access, by);
  }

  signOutSessionById(by: EventActor, id: string): void {
    access.signOutSessionById(this.access, by, id);
  }

  clearAccess(by: EventActor): void {
    access.clearAccess(this.access, by);
  }

  pruneAccess(): { sessions: number; invites: number } {
    return access.pruneAccess(this.access);
  }
}
