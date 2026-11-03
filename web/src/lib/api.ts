import type {
  CrewSchedule,
  CrewScheduleInput,
  Agent,
  AgentRun,
  Analytics,
  Autonomy,
  BlockedTool,
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
} from "@crane/contracts";

export type { DiffFile, DiffHunk, DiffLine } from "@crane/contracts";
export type {
  TaskGates,
  Lookout,
  Agent,
  AgentRun,
  Analytics,
  Autonomy,
  BlockedTool,
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

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = <T>(path: string, json: unknown = {}) => req<T>(path, { method: "POST", json });

export const api = {
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
