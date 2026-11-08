import type {
  Goal,
  GoalDetail,
  GoalListItem,
  GoalPlan,
  NewGoal,
  CrewSchedule,
  CrewScheduleInput,
  Agent,
  AgentRun,
  Analytics,
  Autonomy,
  BlockedTool,
  CommandAccess,
  DriverInfo,
  Lookout,
  PostmortemSettings,
  RetentionSettings,
  MaintenanceRole,
  MaintenanceRoleInfo,
  RepoTools,
  Task,
  TaskSummary,
  TaskEvent,
  TaskKind,
  TaskStatus,
  NewTask,
  Overview,
  Repo,
  TaskDetail,
  TaskDiff,
  TaskDraft,
  TaskGates,
  TaskRunOptions,
  RoleRunOptions,
  AuthStatus,
  OperatorProfile,
  OperatorSession,
  OperatorSummary,
  OperatorRole,
  InviteSummary,
  InviteCheck,
} from "@crane/contracts";
import type { InviteLink } from "./operators";
import { SignedOutError, isSignInRefusal, notifySignInRequired } from "./auth";

export type { DiffFile, DiffHunk, DiffLine } from "@crane/contracts";
export type {
  TaskGates,
  Lookout,
  Agent,
  AgentRun,
  Analytics,
  Autonomy,
  BlockedTool,
  CommandAccess,
  DriverInfo,
  PostmortemSettings,
  MaintenanceRole,
  MaintenanceRoleInfo,
  RepoTools,
  Task,
  TaskSummary,
  TaskEvent,
  TaskKind,
  TaskStatus,
  Overview,
  Repo,
  TaskDetail,
  TaskDiff,
  TaskDraft,
  TaskRunOptions,
};
export {
  ACTIVE_STATUSES,
  AUTONOMY_LABEL,
  KIND_LABEL,
  LOOKOUT,
  LOOKOUTS,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  RUN_KIND_LABEL,
  STATUS_LABEL,
  acceptanceCheckRun,
  acceptanceFor,
  choosableDrivers,
  driverLabel,
  followUpFor,
  lastMergeOutcome,
  lookoutsLabel,
  isScheduled,
  parseDiff,
  prerequisiteMet,
  splitRows,
  UNSHIPPED_STATUSES,
  ruleLabel,
  settingsLabel,
  unmetAcceptance,
} from "@crane/contracts";

/** What the Make this change form schedules a follow-up with. */
export type FollowUpOptions = TaskRunOptions & TaskGates & { lookouts?: Lookout[] };

/** A refused call, with what the server answered, such as a sign-in's `retryAfterSeconds`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The error a failed response throws. A refusal for want of a session also tells the app to show sign-in. */
export function responseError(status: number, body: unknown): Error {
  const message = (body as { error?: string } | null)?.error ?? `Request failed (${status})`;
  if (!isSignInRefusal(status, body)) return new ApiError(message, status, body);
  notifySignInRequired();
  return new SignedOutError(message);
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw responseError(res.status, body);
  return body as T;
}

const post = <T>(path: string, json: unknown = {}) => req<T>(path, { method: "POST", json });

export const api = {
  /** Whether sign-in is required here, and who this device is signed in as. Answers without a session. */
  session: () => req<AuthStatus>("/auth/session"),
  /** Sets the session cookie. A wrong username or password is a 401, and too many attempts a 429 with `retryAfterSeconds`. */
  signIn: (username: string, password: string) => post<AuthStatus>("/auth/sign-in", { username, password }),
  signOut: () => post<AuthStatus>("/auth/sign-out"),
  /** This operator's signed-in devices, with this one marked `current`. */
  mySessions: () => req<OperatorSession[]>("/auth/me/sessions"),
  /** Signs out one of this operator's devices and answers with those left; signing out this one answers []. */
  signOutMySession: (id: string) => req<OperatorSession[]>(`/auth/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  signOutMyOtherSessions: () => post<OperatorSession[]>("/auth/me/sessions/sign-out-others"),
  /** Keeps this device signed in and signs out the operator's others. A wrong current password is refused. */
  changeMyPassword: (current: string, next: string) => post<{ ok: true }>("/auth/me/password", { current, next }),
  renameMe: (name: string) => post<OperatorProfile>("/auth/me/name", { name }),
  operators: () => req<OperatorSummary[]>("/operators"),
  invites: () => req<InviteSummary[]>("/operators/invites"),
  inviteOperator: (role: OperatorRole, name?: string) => post<InviteLink>("/operators/invites", { role, name }),
  revokeInvite: (id: string) => req<InviteSummary[]>(`/operators/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setOperatorRole: (id: string, role: OperatorRole) => post<OperatorSummary[]>(`/operators/${encodeURIComponent(id)}/role`, { role }),
  resetOperatorPassword: (id: string) => post<InviteLink>(`/operators/${encodeURIComponent(id)}/reset`),
  signOutOperator: (id: string) => post<OperatorSummary[]>(`/operators/${encodeURIComponent(id)}/sign-out`),
  removeOperator: (id: string) => req<OperatorSummary[]>(`/operators/${encodeURIComponent(id)}`, { method: "DELETE" }),
  checkInvite: (token: string) => post<InviteCheck>("/auth/invites/check", { token }),
  acceptInvite: (token: string, input: { username?: string; name?: string; password: string }) =>
    post<AuthStatus>("/auth/invites/accept", { token, ...input }),
  goals:() => req<GoalListItem[]>("/goals"),
  goal: (id: string) => req<GoalDetail>(`/goals/${id}`),
  createGoal: (input: NewGoal) => post<Goal>("/goals", input),
  goalFeedback: (id: string, revision: number, feedback: string) => post<Goal>(`/goals/${id}/feedback`, { revision, feedback }),
  editGoalPlan: (id: string, revision: number, plan: GoalPlan) => req<Goal>(`/goals/${id}/plan`, { method: "PUT", json: { revision, plan } }),
  approveGoal: (id: string, revision: number, autoMerge: boolean) => post<Goal>(`/goals/${id}/approve`, { revision, autoMerge }),
  cancelGoal: (id: string, revision: number) => post<Goal>(`/goals/${id}/cancel`, { revision }),
  retryGoalTask: (id: string, revision: number, taskId: string, run: TaskRunOptions = {}) => post<Goal>(`/goals/${id}/tasks/${taskId}/retry`, { revision, ...run }),
  changeGoalPlanAgent: (id: string, revision: number, key: string, run: TaskRunOptions) => post<Goal>(`/goals/${id}/plan/tasks/${key}/agent`, { revision, ...run }),
  changeAgent: (id: string, run: TaskRunOptions) => post<Task>(`/tasks/${id}/agent`, run),
  overview: () => req<Overview>("/overview"),
  analytics: (days: number) => req<Analytics>(`/analytics?days=${days}`),
  tasks: (status?: string) => req<TaskSummary[]>(`/tasks${status ? `?status=${status}` : ""}`),
  queue: () => req<TaskSummary[]>("/tasks/queue"),
  moveQueuedTask: (id: string, beforeId: string | null) => post<TaskSummary[]>(`/tasks/${id}/move`, { beforeId }),
  task: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  diff: (id: string) => req<TaskDiff>(`/tasks/${id}/diff`),
  draft: (text: string) => post<TaskDraft>("/instruct/draft", { text }),
  createTask: (m: NewTask) => post<Task>("/tasks", m),
  schedule: (id: string, scheduledAt: string | null) => post<Task>(`/tasks/${id}/schedule`, { scheduledAt }),
  /** Approve, and merge and push the branch unless `merge` is false ("Approve only"). */
  approve: (id: string, opts: { note?: string; merge?: boolean } = {}) => post<Task>(`/tasks/${id}/approve`, opts),
  merge: (id: string) => post<Task>(`/tasks/${id}/merge`),
  /** Approve a queued or running task ahead of time, so it merges once its checks pass. */
  preApprove: (id: string, note?: string) => post<Task>(`/tasks/${id}/pre-approve`, { note }),
  recordVisualReview: (id: string, input: { status: "inspected" | "waived"; commit: string; note: string }) => post<Task>(`/tasks/${id}/visual-review`, input),
  undoPreApproval: (id: string) => req<Task>(`/tasks/${id}/pre-approve`, { method: "DELETE" }),
  /** Start a queued task without the prerequisites that haven't landed, approving a reduced scope. */
  waivePrerequisites: (id: string, note?: string) => post<Task>(`/tasks/${id}/waive-prerequisites`, { note }),
  reject: (id: string, note?: string) => post<Task>(`/tasks/${id}/reject`, { note }),
  cancel: (id: string) => post<Task>(`/tasks/${id}/cancel`),
  /** Run it again as a new task, on the same agent unless `driver` names another. */
  retry: (id: string, driver?: string) => post<Task>(`/tasks/${id}/retry`, driver ? { driver } : {}),
  followUp: (id: string, finding: number, opts: FollowUpOptions = {}) => post<Task>(`/tasks/${id}/follow-up`, { finding, ...opts }),
  repos: () => req<Repo[]>("/repos"),
  addRepo: (path: string, name?: string) => post<Repo>("/repos", { path, name }),
  removeRepo: (id: string) => req<{ ok: true }>(`/repos/${id}`, { method: "DELETE" }),
  repoChecks: (id: string) => req<string[]>(`/repos/${id}/checks`),
  /** Replace the commands this repo's work must pass before review and merge. */
  configureChecks: (id: string, commands: string[]) => req<string[]>(`/repos/${id}/checks`, { method: "PUT", json: commands }),
  /** Let agents in this repo use a command they were blocked from. Crane's deny list still wins. */
  allowTool: (repoId: string, rule: string, taskId?: string) => post<RepoTools>(`/repos/${repoId}/tools/allow`, { rule, taskId }),
  keepBlocked: (repoId: string, rule: string, taskId?: string) =>
    post<RepoTools>(`/repos/${repoId}/tools/keep-blocked`, { rule, taskId }),
  disallowTool: (repoId: string, rule: string) => post<RepoTools>(`/repos/${repoId}/tools/disallow`, { rule }),
  /** Choose which commands Claude Code agents in this repo may run, from their next run. */
  setCommandAccess: (repoId: string, commands: CommandAccess, taskId?: string) =>
    req<RepoTools>(`/repos/${repoId}/tools/commands`, { method: "PUT", json: { commands, taskId } }),
  configureCrew: (id: string, input: { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null }) =>
    post<Agent>(`/agents/${id}`, input),
  /** Start a crew member's maintenance run. Only that member picks it up. */
  runRole: (id: string, opts: RoleRunOptions = {}) => post<Task>(`/agents/${id}/run`, opts),
  agents: () => req<Agent[]>("/agents"),
  /** Every member's schedules in one request, so the crew page polls once rather than per member. */
  crewSchedules: () => req<CrewSchedule[]>("/crew/schedules"),
  saveCrewSchedule: (id: string, input: CrewScheduleInput, scheduleId?: string) =>
    post<CrewSchedule>(`/agents/${id}/schedules${scheduleId ? `/${scheduleId}` : ""}`, input),
  removeCrewSchedule: (id: string, scheduleId: string) => req<{ ok: true }>(`/agents/${id}/schedules/${scheduleId}`, { method: "DELETE" }),
  drivers: () => req<DriverInfo[]>("/drivers"),
  setDefaultDriver: (driver: string) => post<DriverInfo[]>("/factory/driver", { driver }),
  configureDriver: (driver: string, input: { model?: string | null; effort?: string | null }) =>
    post<DriverInfo[]>(`/drivers/${driver}`, input),
  postmortemSettings: () => req<PostmortemSettings>("/factory/postmortem"),
  retentionSettings: () => req<RetentionSettings>("/factory/retention"),
  configureRetention: (input: RetentionSettings) => post<RetentionSettings>("/factory/retention", input),
  configurePostmortem: (input: PostmortemSettings) => post<PostmortemSettings>("/factory/postmortem", input),
  pause: () => post("/factory/pause"),
  resume: () => post("/factory/resume"),
};
