import {
  AUTONOMY_LABEL,
  KIND_LABEL,
  driverLabel,
  settingsLabel,
  type NewTask,
  type Task,
  type TaskGates,
  type TaskRunOptions,
} from "@crane/contracts";
import type { Store } from "../../core/store.js";
import type { NewTaskRecord } from "../../core/store/tasks.js";
import {
  MAX_GATES,
  checkAcceptance,
  checkAcceptanceChecks,
  checkLookouts,
  checkScheduledAt,
  checkTaskRunOptions,
  nextRun,
  type TaskRun,
} from "../action-inputs.js";

export function needTask(store: Store, id: string): Task {
  const m = store.getTask(id);
  if (!m) throw new Error(`No task ${id}`);
  return m;
}

function runLabel(run: TaskRun): string {
  const settings = settingsLabel({ model: run.model, effort: run.effort });
  return `${run.driver ? driverLabel(run.driver) : "the default agent"}${settings ? ` (${settings})` : ""}`;
}

/**
 * Prerequisites, acceptance criteria and acceptance checks for a new task,
 * checked. Each prerequisite must be an existing task in the same repo, since
 * only its landing there puts its changes in this task's checkout.
 */
function checkGates(store: Store, input: TaskGates, repoId: string | null): Required<TaskGates> {
  const acceptance = checkAcceptance(input.acceptance);
  const acceptanceChecks = checkAcceptanceChecks(input.acceptanceChecks, repoId ? store.repoChecks(repoId) : []);
  const given: unknown = input.prerequisites ?? [];
  if (!Array.isArray(given) || given.some((id) => typeof id !== "string")) throw new Error("Prerequisites must be a list of task ids");
  const prerequisites: string[] = [];
  for (const raw of given as string[]) {
    const id = raw.trim();
    if (!id) continue;
    const t = store.getTask(id);
    if (!t) throw new Error(`No task ${id} to wait for`);
    if (t.repoId !== repoId) throw new Error(`Task ${t.id} is in another repo, so its changes would never reach this one`);
    if (!prerequisites.includes(t.id)) prerequisites.push(t.id);
  }
  if (prerequisites.length > MAX_GATES) throw new Error(`Give at most ${MAX_GATES} prerequisites`);
  return { prerequisites, acceptance, acceptanceChecks };
}

/**
 * Check a new task in the order API clients and tests see errors, and return
 * what to store: factory work with no repo goes to Crane's own, if connected.
 */
function checkNewTask(store: Store, input: NewTask & { scheduleId?: string }): NewTaskRecord {
  // From the API and CLI flags as given. Only an exact "observe" is read-only, so "Observe" would get a writing agent.
  if (!Object.hasOwn(AUTONOMY_LABEL, input.autonomy)) throw new Error(`Unknown autonomy “${input.autonomy}”. Use one of: ${Object.keys(AUTONOMY_LABEL).join(", ")}`);
  if (!Object.hasOwn(KIND_LABEL, input.kind)) throw new Error(`Unknown kind “${input.kind}”. Use one of: ${Object.keys(KIND_LABEL).join(", ")}`);
  if (typeof input.brief !== "string") throw new Error("A task's brief must be text");
  if (input.preApprove !== undefined && typeof input.preApprove !== "boolean") throw new Error("Pre-approval must be a boolean");
  if (input.preApprove && input.autonomy === "observe") throw new Error("This task is investigate-only, so it has nothing to merge");
  if (input.acceptanceChecks?.length && input.autonomy === "observe") throw new Error("This task is investigate-only, so Crane runs no checks on it");
  if (input.kind !== "factory_feature" && !input.repoId) throw new Error("Choose a repo for this task");
  const repoId = input.repoId || (store.listRepos().find((r) => r.isFactory)?.id ?? null);
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Give the task a title");
  // Nobody else claims an assigned task, so it must name someone on the crew.
  if (input.assignee && !store.listAgents().some((a) => a.id === input.assignee)) {
    throw new Error(`No crew member ${input.assignee}`);
  }
  return {
    ...input,
    repoId,
    ...checkTaskRunOptions(input),
    ...checkGates(store, input, repoId),
    lookouts: checkLookouts(input.lookouts),
    scheduledAt: checkScheduledAt(input.scheduledAt),
    assignee: input.assignee || null,
    driverSettings: null,
  };
}

export function createTask(store: Store, input: NewTask & { scheduleId?: string }): Task {
  const task = store.createTask(checkNewTask(store, input));
  // Remembered so the next instruction that doesn't name a repo defaults to this one.
  if (task.repoId) store.setSetting("last_repo", task.repoId);
  return task;
}

/** Reorder waiting work; scheduling, crew assignment and prerequisites still apply. */
export function moveQueuedTask(store: Store, id: string, beforeId: unknown): Task[] {
  if (beforeId !== null && (typeof beforeId !== "string" || !beforeId.trim())) {
    throw new Error("Give beforeId as a task id, or null to move to the end of the queue");
  }
  return store.moveQueuedTask(needTask(store, id).id, beforeId === null ? null : needTask(store, beforeId).id);
}

/** Reschedule queued work, or clear its time without waiving prerequisites. */
export function schedule(store: Store, id: string, scheduledAt: unknown): Task {
  const task = needTask(store, id);
  const time = checkScheduledAt(scheduledAt);
  if (!store.setTaskSchedule(task.id, time)) throw new Error(`Task ${task.id} isn't queued, so its start time can't change`);
  return needTask(store, task.id);
}

/**
 * Change the agent, model or effort of a task that hasn't started. It applies
 * when a crew member picks the task up. A task that already ran starts a new
 * session on the work so far if the agent changes.
 */
export function changeAgent(store: Store, id: string, input: TaskRunOptions): Task {
  const m = needTask(store, id);
  if (!input || (input.driver === undefined && input.model === undefined && input.effort === undefined)) {
    throw new Error("Give an agent, model or effort to change");
  }
  const run = nextRun(m, input);
  if (m.status !== "queued") throw new Error(`Task ${m.id} isn't queued, so its agent can't change`);
  if (run.driver === m.driver && run.model === m.model && run.effort === m.effort) return m;
  if (!store.setTaskAgent(m.id, run, `Changed agent to ${runLabel(run)}`)) {
    throw new Error(`Task ${m.id} isn't queued, so its agent can't change`);
  }
  return needTask(store, id);
}

/**
 * Let a queued task start without waiting for its prerequisites to land. This
 * is the operator approving a reduced scope: the agent is told their changes
 * may be missing, and works from what's on the default branch.
 */
export function waivePrerequisites(store: Store, id: string, note?: string): Task {
  const m = needTask(store, id);
  if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
  const waiting = store.unmetPrerequisites(m);
  if (!waiting.length) {
    throw new Error(m.prerequisitesWaivedAt ? `Task ${m.id}'s prerequisites are already waived` : `Task ${m.id} isn't waiting for any prerequisites`);
  }
  if (!store.waivePrerequisites(m.id)) throw new Error(`Task ${m.id} isn't queued, so there's nothing to start early`);
  const ids = waiting.map((t) => t.id).join(", ");
  store.addEvent(m.id, "operator", note ? `Waived prerequisites ${ids}: ${note}` : `Waived prerequisites ${ids}`, {
    waived: waiting.map((t) => t.id),
    ...(note ? { note } : {}),
  });
  return needTask(store, id);
}

export function cancel(store: Store, id: string): Task {
  const m = needTask(store, id);
  if (!["queued", "running"].includes(m.status)) throw new Error(`Task ${m.id} isn't in progress`);
  store.addEvent(m.id, "operator", "Cancelled by operator");
  store.setStatus(m.id, "cancelled", "Cancelled");
  return needTask(store, id);
}

/**
 * Run a task again as a new one. It keeps the agent the operator chose for
 * it, unless `driver` names another (null or "default" for the factory's default).
 */
export function retry(store: Store, id: string, opts: { driver?: string | null } = {}): Task {
  const goalId = store.goalForTask(needTask(store, id).id);
  if (goalId) throw new Error(`This task belongs to goal ${goalId}. Send feedback or retry the task from that goal to preserve its dependencies`);
  return retryTask(store, id, opts);
}

/** `retry` without the goal check, for the goal actions that keep a retried task in its goal. */
export function retryTask(store: Store, id: string, opts: TaskRunOptions = {}): Task {
  const m = needTask(store, id);
  const run = nextRun(m, opts);
  const tuned = opts.model !== undefined || opts.effort !== undefined;
  // A maintenance run goes back to the member it was started for.
  const next = store.createTask({ kind: m.kind, title: m.title, brief: m.brief, repoId: m.repoId, autonomy: m.autonomy,
    ...run, assignee: m.assignee,
    // Captured settings would fill in for a model or effort the operator just cleared.
    driverSettings: run.driver === m.driver && !tuned ? m.driverSettings : null, postmortemOf: m.postmortemOf,
    // The same gates, but not a waiver: that approved the scope of the earlier run only.
    prerequisites: m.prerequisites, acceptance: m.acceptance, acceptanceChecks: m.acceptanceChecks, lookouts: m.lookouts });
  const on = opts.driver !== undefined || tuned ? ` on ${runLabel(run)}` : "";
  store.addEvent(m.id, "operator", `Retried as ${next.id}${on}`, { taskId: next.id });
  return next;
}

/**
 * Turn one finding from a report into its own task that is allowed to make
 * the change, optionally waiting on prerequisites, held to acceptance
 * criteria, and looking out for more along the way.
 */
export function followUp(store: Store, id: string, findingIndex: number, opts: TaskRunOptions & TaskGates & Pick<NewTask, "lookouts"> = {}): Task {
  const m = needTask(store, id);
  if (!Number.isInteger(findingIndex) || findingIndex < 0) throw new Error("Choose a finding by its number");
  const f = m.report?.findings[findingIndex];
  if (!f) throw new Error(`Task ${m.id} has no finding #${findingIndex + 1}`);
  const settings = nextRun(m, opts);
  const gates = checkGates(store, opts, m.repoId);
  const lookouts = checkLookouts(opts.lookouts);
  const next = store.createTask({
    kind: m.kind,
    title: f.title,
    brief: `${f.detail}\n\nFollow-up to task ${m.id}: “${m.title}”.`,
    repoId: m.repoId,
    autonomy: "propose",
    ...settings,
    ...gates,
    lookouts,
    followUp: { of: m.id, finding: findingIndex },
  });
  store.addEvent(m.id, "operator", `Started follow-up ${next.id}: ${f.title}`, { taskId: next.id, finding: findingIndex });
  return next;
}
