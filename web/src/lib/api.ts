import type {
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
} from "@crane/contracts";

export type {
  TaskGates,
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
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  RUN_KIND_LABEL,
  STATUS_LABEL,
  acceptanceFor,
  choosableDrivers,
  diffFiles,
  driverLabel,
  lastMergeOutcome,
  ruleLabel,
  settingsLabel,
  unmetAcceptance,
} from "@crane/contracts";

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
  tasks: (status?: string) => req<Task[]>(`/tasks${status ? `?status=${status}` : ""}`),
  task: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  diff: (id: string) => req<TaskDiff>(`/tasks/${id}/diff`),
  draft: (text: string) => post<TaskDraft>("/instruct/draft", { text }),
  createTask: (m: NewTask) => post<Task>("/tasks", m),
  /** Approve, and merge and push the branch unless `merge` is false ("Approve only"). */
  approve: (id: string, opts: { note?: string; merge?: boolean } = {}) => post<Task>(`/tasks/${id}/approve`, opts),
  merge: (id: string) => post<Task>(`/tasks/${id}/merge`),
  /** Approve a queued or running task ahead of time, so it merges once its checks pass. */
  preApprove: (id: string, note?: string) => post<Task>(`/tasks/${id}/pre-approve`, { note }),
  undoPreApproval: (id: string) => req<Task>(`/tasks/${id}/pre-approve`, { method: "DELETE" }),
  /** Start a queued task without the prerequisites that haven't landed, approving a reduced scope. */
  waivePrerequisites: (id: string, note?: string) => post<Task>(`/tasks/${id}/waive-prerequisites`, { note }),
  reject: (id: string, note?: string) => post<Task>(`/tasks/${id}/reject`, { note }),
  cancel: (id: string) => post<Task>(`/tasks/${id}/cancel`),
  /** Run it again as a new task, on the same agent unless `driver` names another. */
  retry: (id: string, driver?: string) => post<Task>(`/tasks/${id}/retry`, driver ? { driver } : {}),
  followUp: (id: string, finding: number, opts: TaskRunOptions & TaskGates = {}) => post<Task>(`/tasks/${id}/follow-up`, { finding, ...opts }),
  repos: () => req<Repo[]>("/repos"),
  addRepo: (path: string, name?: string) => post<Repo>("/repos", { path, name }),
  removeRepo: (id: string) => req<{ ok: true }>(`/repos/${id}`, { method: "DELETE" }),
  /** Let agents in this repo use a command they were blocked from. Crane's deny list still wins. */
  allowTool: (repoId: string, rule: string, taskId?: string) => post<RepoTools>(`/repos/${repoId}/tools/allow`, { rule, taskId }),
  keepBlocked: (repoId: string, rule: string, taskId?: string) =>
    post<RepoTools>(`/repos/${repoId}/tools/keep-blocked`, { rule, taskId }),
  disallowTool: (repoId: string, rule: string) => post<RepoTools>(`/repos/${repoId}/tools/disallow`, { rule }),
  configureCrew: (id: string, input: { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null }) =>
    post<Agent>(`/agents/${id}`, input),
  /** Start a crew member's maintenance run. Only that member picks it up. */
  runRole: (id: string) => post<Task>(`/agents/${id}/run`),
  agents: () => req<Agent[]>("/agents"),
  drivers: () => req<DriverInfo[]>("/drivers"),
  setDefaultDriver: (driver: string) => post<DriverInfo[]>("/factory/driver", { driver }),
  configureDriver: (driver: string, input: { model?: string | null; effort?: string | null }) =>
    post<DriverInfo[]>(`/drivers/${driver}`, input),
  postmortemSettings: () => req<PostmortemSettings>("/factory/postmortem"),
  configurePostmortem: (input: PostmortemSettings) => post<PostmortemSettings>("/factory/postmortem", input),
  pause: () => post("/factory/pause"),
  resume: () => post("/factory/resume"),
};
