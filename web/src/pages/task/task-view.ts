import {
  driverLabel,
  isScheduled,
  lastMergeOutcome,
  unmetAcceptance,
  UNSHIPPED_STATUSES,
  visualReviewPending,
  visualReviewWaivedByPreApproval,
  type Agent,
  type AgentRun,
  type FollowUpState,
  type PrerequisiteState,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from "@crane/contracts";

/** What the task page derives from a task's detail, read by more than one part of it. */
export function taskView(detail: TaskDetail, events: TaskEvent[]) {
  const { task, repo } = detail;
  // A backend older than this page sends no gates, follow-ups or source; read them as empty until it restarts.
  const prerequisites = detail.prerequisites ?? [];
  const acceptance = task.acceptance ?? [];
  const acceptanceChecks = task.acceptanceChecks ?? [];
  const required = acceptance.length + acceptanceChecks.length;
  return {
    main: repo?.defaultBranch ?? "main",
    merge: lastMergeOutcome(events),
    usedDriver: usedDriver(task, detail.runs),
    // Only before review: once it's there, Approve is the decision.
    canPreApprove: ["queued", "running"].includes(task.status) && task.autonomy !== "observe" && !!repo,
    prerequisites,
    waitingOn: waitingOn(task, prerequisites),
    acceptance,
    acceptanceChecks,
    required,
    unmet: task.report ? unmetAcceptance({ ...task, acceptance, acceptanceChecks }) : [],
    acceptanceGate: required ? " and its report shows every acceptance criterion met" : "",
    // Tasks started from this task's findings; each finding shows the state of its latest one.
    followUps: detail.followUps ?? [],
    // The task and finding this one came from.
    source: detail.followUpSource ?? null,
  };
}

export type TaskView = ReturnType<typeof taskView>;

/** Whether an agent is working on the task's branch right now, so its changes are worth following live. */
export const isWorking = (task: Task | undefined): boolean => task?.status === "running" && !!task.branch;

/**
 * The agent that worked it, or the one it asked for. Before it starts with no choice, nothing to say.
 * A queued task runs next on whoever the operator chose, even if another agent worked it before.
 */
export function usedDriver(task: Pick<Task, "status" | "driver">, runs: Pick<AgentRun, "kind" | "driver">[]): string | null {
  const ranOn = runs.filter((r) => r.kind === "work" && r.driver !== "unknown").at(-1)?.driver ?? null;
  if (task.status === "queued") return task.driver ?? ranOn;
  return ranOn ?? task.driver;
}

/** The label for the agent the task runs on, or null when there's none yet. */
export function driverName(driver: string | null): string | null {
  return driver ? driverLabel(driver) : null;
}

/** Prerequisites still holding a queued task back. Waiving them is the operator approving a reduced scope. */
export function waitingOn(task: Pick<Task, "status" | "prerequisitesWaivedAt">, prerequisites: PrerequisiteState[]): PrerequisiteState[] {
  if (task.status !== "queued" || task.prerequisitesWaivedAt) return [];
  return prerequisites.filter((p) => !p.met);
}

interface PendingContext {
  agent: Pick<Agent, "name" | "active"> | null;
  waitingOn: Pick<PrerequisiteState, "id">[];
  /** Names of the crew members who run post-mortems. */
  postmortemCrew: string[];
}

function queuedSummary(task: Task, { agent, waitingOn: waiting, postmortemCrew }: PendingContext): string {
  if (isScheduled(task)) {
    return `Scheduled for ${new Date(task.scheduledAt!).toLocaleString()}. It starts when an agent is free after this time and prerequisites are met.`;
  }
  if (waiting.length) return `Waiting for ${waiting.map((p) => p.id).join(", ")} to land.`;
  if (task.assignee && agent) {
    return agent.active ? `Waiting for ${agent.name}, who picks it up when free.` : `Waiting for ${agent.name}, who is on-call. Activate them on the Crew page.`;
  }
  if (task.postmortemOf && postmortemCrew.length) return `Waiting for a crew member who runs post-mortems: ${postmortemCrew.join(", ")}.`;
  return "Waiting for a free agent.";
}

/** What to say about a task with no report yet. Other statuses have nothing to add here. */
export function pendingSummary(task: Task, context: PendingContext): string | null {
  if (task.status === "running") return `${context.agent?.name ?? "An agent"} is working on this. Updates appear below as they happen.`;
  if (task.status === "queued") return queuedSummary(task, context);
  return null;
}

export function mergingSummary(agent: Pick<Agent, "name"> | null, main: string): string {
  const who = agent ? `${agent.name} is merging this into ${main}.` : `Waiting for a free agent to merge this into ${main}.`;
  return `${who} Progress appears in the activity below.`;
}

/** Which crew schedule started the task, in the words of the event that recorded it. */
export function scheduleOrigin(task: Pick<Task, "scheduleId">, events: TaskEvent[]): string {
  return events.find((e) => e.data?.scheduleId === task.scheduleId)?.message ?? `Started by crew schedule ${task.scheduleId}`;
}

type VisualReviewTask = Pick<Task, "branch" | "visualReview" | "preApprovedAt">;

export function visualReviewHeading(task: VisualReviewTask): string | undefined {
  if (visualReviewPending(task)) return "Needs your decision";
  if (visualReviewWaivedByPreApproval(task)) return "Waived by pre-approval";
  return task.visualReview?.status.replace("_", " ");
}

export function visualReviewText(task: VisualReviewTask): string | undefined {
  if (visualReviewPending(task)) return "Approval and merging wait for candidate inspection or an explicit waiver.";
  if (visualReviewWaivedByPreApproval(task)) return "Your pre-approval waives visual review for this task, including conflict resolutions.";
  return task.visualReview?.note;
}

export function decisionHeading(branch: string | null, mergeError: string | undefined, main: string): string {
  if (mergeError) return `Couldn't merge into ${main}`;
  return branch ? "Changes are ready for review" : "The report is ready";
}

function unmetWarning(unmet: number): string {
  if (unmet === 0) return "";
  const criteria = unmet === 1 ? "an acceptance criterion" : `${unmet} acceptance criteria`;
  return `The report doesn't show ${criteria} met, so approving accepts a reduced scope. `;
}

function nextStep(branch: string | null, mergeError: string | undefined, main: string): string {
  if (mergeError) return `${mergeError.replace(/\.$/, "")}. Try again, approve only to merge it yourself, or decline.`;
  if (branch) return `Approving merges ${branch} into ${main} and pushes it. An agent resolves any conflicts. Declining throws it away.`;
  return "Act on a finding below, or mark this as reviewed.";
}

export function decisionText(input: { branch: string | null; mergeError: string | undefined; main: string; unmet: number }): string {
  return unmetWarning(input.unmet) + nextStep(input.branch, input.mergeError, input.main);
}

export function prerequisitesText(count: number, main: string): string {
  if (count === 1) return `It waits for this to land on ${main}. Waive it to run without its changes, approving a reduced scope. Its start time still applies.`;
  return `It waits for these to land on ${main}. Waive them to run without their changes, approving a reduced scope. Its start time still applies.`;
}

export function preApprovalText(preApproved: boolean, main: string, acceptanceGate: string): string {
  if (preApproved) return `Once its checks pass${acceptanceGate}, Crane merges it into ${main}. Your pre-approval also waives visual review, including conflict resolutions.`;
  return `Pre-approve it and Crane merges it into ${main} once its checks pass${acceptanceGate}. This also waives visual review, including conflict resolutions.`;
}

/** A follow-up that failed, was cancelled, or was declined shipped nothing, so its finding can be tried again. */
export function canStartFollowUp(started: Pick<FollowUpState, "status"> | undefined): boolean {
  return !started || UNSHIPPED_STATUSES.includes(started.status);
}

export function runOutcomeLabel(outcome: AgentRun["outcome"]): string | null {
  if (outcome === "failed") return "Failed";
  if (outcome === "cancelled") return "Cancelled";
  return null;
}

/** Runs are worth listing when there are several, or the one has spent something. */
export function showsRuns(runs: Pick<AgentRun, "costUsd" | "outputTokens">[]): boolean {
  if (runs.length > 1) return true;
  const only = runs[0];
  return !!only && (only.costUsd > 0 || only.outputTokens > 0);
}

export interface ToolGroup {
  tools: TaskEvent[];
}

/** Group consecutive tool calls so the timeline reads as a story, with the mechanics one click away. */
export function groupEvents(events: TaskEvent[]): (TaskEvent | ToolGroup)[] {
  const out: (TaskEvent | ToolGroup)[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type !== "tool") out.push(e);
    else if (last && "tools" in last) last.tools.push(e);
    else out.push({ tools: [e] });
  }
  return out;
}

/** The stream can replay what a poll already returned, so each event is kept once, in the order first seen. */
export function uniqueEvents(polled: TaskEvent[], live: TaskEvent[]): TaskEvent[] {
  const seen = new Set<number>();
  return [...polled, ...live].filter((e) => !seen.has(e.id) && seen.add(e.id));
}

export function addLiveEvent(live: TaskEvent[], event: TaskEvent): TaskEvent[] {
  return live.some((e) => e.id === event.id) ? live : [...live, event];
}

/** Never show another task's changes while this one's load. */
export function changesFor<T>(state: { id: string; diff: T | null; error: string | null }, id: string) {
  return state.id === id ? { diff: state.diff, error: state.error } : { diff: null, error: null };
}
