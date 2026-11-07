import { isEventActor, isLookout, type EventActor, type Repo, type Task, type TaskStatus, type DriverSettings, type Report,
  type TaskEvent, type EventType, type AgentRun, type RunKind, type RunOutcome, type RunUsage,
  type Agent, type AgentState } from "@crane/contracts";

export type Row = Record<string, unknown>;

export function toRepo(r: Row): Repo {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    defaultBranch: r.default_branch as string,
    isFactory: !!r.is_factory,
    addedAt: r.added_at as string,
  };
}

export function toTask(r: Row): Task {
  return {
    id: r.id as string,
    kind: r.kind as Task["kind"],
    title: r.title as string,
    brief: r.brief as string,
    repoId: (r.repo_id as string) ?? null,
    autonomy: r.autonomy as Task["autonomy"],
    status: r.status as TaskStatus,
    agentId: (r.agent_id as string) ?? null,
    branch: (r.branch as string) ?? null,
    worktree: (r.worktree as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    driver: (r.driver as string) ?? null,
    model: (r.model as string) ?? null,
    effort: (r.effort as string) ?? null,
    driverSettings: r.driver_settings ? JSON.parse(r.driver_settings as string) as DriverSettings : null,
    assignee: (r.assignee as string) ?? null,
    postmortemOf: (r.postmortem_of as string) ?? null,
    preApprovedAt: (r.pre_approved_at as string) ?? null,
    visualReview: r.visual_review ? JSON.parse(r.visual_review as string) : null,
    reviewCheckpoint: r.review_checkpoint ? JSON.parse(r.review_checkpoint as string) : null,
    prerequisites: r.prerequisites ? JSON.parse(r.prerequisites as string) as string[] : [],
    prerequisitesWaivedAt: (r.prerequisites_waived_at as string) ?? null,
    acceptance: r.acceptance ? JSON.parse(r.acceptance as string) as string[] : [],
    acceptanceChecks: r.acceptance_checks ? JSON.parse(r.acceptance_checks as string) as string[] : [],
    // A lookout this build doesn't know (written by a newer one) is dropped rather than shown raw.
    lookouts: r.lookouts ? (JSON.parse(r.lookouts as string) as unknown[]).filter(isLookout) : [],
    report: r.report ? (JSON.parse(r.report as string) as Report) : null,
    costUsd: (r.cost_usd as number) ?? 0,
    createdAt: r.created_at as string,
    createdBy: storedActor(r.created_by),
    scheduledAt: (r.scheduled_at as string) ?? null,
    scheduleId: (r.schedule_id as string) ?? null,
    followUpOf: (r.follow_up_of as string) ?? null,
    followUpFinding: (r.follow_up_finding as number) ?? null,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function storedActor(raw: unknown): EventActor | null {
  if (typeof raw !== "string") return null;
  try {
    const actor: unknown = JSON.parse(raw);
    return isEventActor(actor) ? actor : null;
  } catch {
    return null;
  }
}

export function toEvent(r: Row): TaskEvent {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    ts: r.ts as string,
    type: r.type as EventType,
    message: r.message as string,
    data: r.data ? JSON.parse(r.data as string) : null,
  };
}

export function toRun(r: Row): AgentRun {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    kind: r.kind as RunKind,
    agentId: (r.agent_id as string) ?? null,
    driver: r.driver as string,
    model: (r.model as string) ?? null,
    outcome: r.outcome as RunOutcome,
    costUsd: r.cost_usd as number,
    costStatus: r.cost_status as RunUsage["costStatus"],
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    turns: r.turns as number,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

/** Local midnight, `days` days before the one containing `ms`. */
export function localDayStart(ms: number, daysBack = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

/** An agent row. The operator's choices for it live in settings; see `Store.listAgents`. */
export function toAgent(r: Row): Omit<Agent, "active" | "defaultDriver" | "role" | "runsPostmortems"> {
  return {
    id: r.id as string,
    name: r.name as string,
    state: r.state as AgentState,
    taskId: (r.task_id as string) ?? null,
    driver: r.driver as string,
    tasksCompleted: r.tasks_completed as number,
    lastActiveAt: (r.last_active_at as string) ?? null,
  };
}
