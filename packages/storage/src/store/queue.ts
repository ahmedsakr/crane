import type { Task, TaskSummary } from "@crane/contracts";
import type { Store } from "../store.js";
import { toTask, type Row } from "./rows.js";
import { now, TASK_DUE } from "./shared.js";
import { TASK_SUMMARY_COLUMNS } from "./tasks.js";

export type TaskAgent = { driver: string | null; model: string | null; effort: string | null };

/** The entire waiting queue, in pickup order, including tasks not yet eligible. */
export function listQueuedTasks(store: Store): Task[] {
  return (store.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY queue_position, created_at, rowid")
    .all() as Row[]).map(toTask);
}

/** The entire pickup order, with the same lightweight payload as other polled rows. */
export function listQueuedTaskSummaries(store: Store): TaskSummary[] {
  return store.db.prepare(`SELECT ${TASK_SUMMARY_COLUMNS} FROM tasks
    WHERE status = 'queued' ORDER BY queue_position, created_at, rowid`).all() as TaskSummary[];
}

/** Move relative to a live anchor, without overwriting concurrent queue changes. */
export function moveQueuedTask(store: Store, id: string, beforeId: string | null): Task[] {
  return store.db.transaction(() => {
    const queue = store.listQueuedTasks();
    const from = queue.findIndex(t => t.id === id);
    if (from < 0) throw new Error(`Task ${id} isn't queued; refresh the queue and try again`);
    if (beforeId !== null && !queue.some(t => t.id === beforeId)) {
      throw new Error(`Task ${beforeId} isn't queued; refresh the queue and try again`);
    }
    if (id === beforeId) return queue;
    const task = queue[from]!;
    queue.splice(from, 1);
    const to = beforeId === null ? queue.length : queue.findIndex(t => t.id === beforeId);
    queue.splice(to, 0, task);
    if (from === to) return queue;
    const update = store.db.prepare("UPDATE tasks SET queue_position = ? WHERE id = ?");
    queue.forEach((t, i) => update.run(i + 1, t.id));
    store.addEvent(id, "operator", beforeId === null ? "Moved to the end of the queue" : `Moved before ${beforeId} in the queue`, { beforeId });
    return queue;
  }).immediate();
}

/** Change pickup time only while queued, and record the decision with the write. */
export function setTaskSchedule(store: Store, id: string, scheduledAt: string | null): boolean {
  scheduledAt = scheduledAt === null ? null : new Date(scheduledAt).toISOString();
  return store.db.transaction(() => {
    const changed = store.db.prepare("UPDATE tasks SET scheduled_at = ? WHERE id = ? AND status = 'queued'")
      .run(scheduledAt, id).changes;
    if (!changed) return false;
    store.addEvent(id, "operator", scheduledAt ? `Scheduled for ${scheduledAt}` : "Cleared start time; ready once prerequisites are met", { scheduledAt });
    return true;
  }).immediate();
}

/**
 * Change who runs a task that hasn't started. The status check is part of the
 * write, so a crew member's claim can't slip in. Captured settings go too: they
 * would otherwise fill in for a model or effort the operator just cleared.
 */
export function setTaskAgent(store: Store, id: string, run: TaskAgent, message: string): boolean {
  return store.db.transaction(() => {
    const changed = store.db.prepare("UPDATE tasks SET driver = ?, model = ?, effort = ?, driver_settings = NULL WHERE id = ? AND status = 'queued'")
      .run(run.driver, run.model, run.effort, id).changes;
    if (!changed) return false;
    store.addEvent(id, "operator", message, run);
    return true;
  }).immediate();
}

/**
 * Unassigned queued work that is no longer waiting for its start time. Post-mortems
 * count only while any active member can run them: activating someone else
 * wouldn't help one that's waiting for the crew the operator named.
 */
export function queuedForAnyone(store: Store): number {
  const named = store.postmortemCrew().length ? "AND postmortem_of IS NULL" : "";
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued' AND assignee IS NULL ${named} AND ${TASK_DUE}`)
    .get(now()) as { n: number }).n;
}
