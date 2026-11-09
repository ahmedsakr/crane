import { FINISHED_STATUSES, type DriverSettings, type NewTask, type Task, type TaskStatus, type TaskSummary } from "@crane/contracts";
import { actorSnapshot } from "@crane/backend-runtime";
import { shortId } from "@crane/backend-runtime";
import type { Store } from "../store.js";
import { toTask, type Row } from "./rows.js";
import { now } from "./shared.js";

export type TaskListOptions = { status?: TaskStatus[]; repoId?: string; assignee?: string; limit?: number };

export type NewTaskRecord = NewTask & {
  driverSettings?: DriverSettings | null;
  /** The recurring crew schedule that started this task. */
  scheduleId?: string;
  /** The task and finding (0-based) this one follows up on. */
  followUp?: { of: string; finding: number };
  /** The merged task this post-mortem reviews. */
  postmortemOf?: string | null;
};

export const TASK_SUMMARY_COLUMNS = `id, kind, title, repo_id AS repoId, status, branch, assignee,
  postmortem_of AS postmortemOf,
  created_at AS createdAt, scheduled_at AS scheduledAt,
  started_at AS startedAt, finished_at AS finishedAt,
  json_extract(report, '$.summary') AS reportSummary,
  COALESCE(json_array_length(report, '$.findings'), 0) AS findingCount,
  COALESCE(json_array_length(report, '$.changedFiles'), 0) AS changedFileCount`;

/** Task fields updateTask can persist, mapped to their database columns. */
const TASK_UPDATE_COLUMNS = {
  status: "status",
  agentId: "agent_id",
  branch: "branch",
  worktree: "worktree",
  sessionId: "session_id",
  report: "report",
  visualReview: "visual_review",
  reviewCheckpoint: "review_checkpoint",
  costUsd: "cost_usd",
  startedAt: "started_at",
  finishedAt: "finished_at",
  title: "title",
} satisfies Partial<Record<keyof Task, string>>;

export type TaskPatch = Partial<Pick<Task, keyof typeof TASK_UPDATE_COLUMNS>>;

const list = (xs: string[] | undefined) => (xs?.length ? JSON.stringify(xs) : null);

function insertTask(store: Store, input: NewTaskRecord, id: string, scheduledAt: string | null) {
  const ts = now();
  store.db
    .prepare(
      `INSERT INTO tasks(id, kind, title, brief, repo_id, autonomy, driver, model, effort, assignee, driver_settings,
         prerequisites, acceptance, acceptance_checks, lookouts, status, created_at, created_by, scheduled_at, pre_approved_at, follow_up_of, follow_up_finding, schedule_id, postmortem_of, queue_position)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(queue_position), 0) + 1 FROM tasks WHERE status = 'queued'))`,
    )
    .run(id, input.kind, input.title, input.brief, input.repoId, input.autonomy, input.driver ?? null,
      input.model ?? null, input.effort ?? null, input.assignee ?? null,
      input.driverSettings ? JSON.stringify(input.driverSettings) : null,
      list(input.prerequisites), list(input.acceptance), list(input.acceptanceChecks), list(input.lookouts), ts, starter(input), scheduledAt,
      input.preApprove ? ts : null, input.followUp?.of ?? null, input.followUp?.finding ?? null, input.scheduleId ?? null, input.postmortemOf ?? null);
}

/** A crew schedule starts its runs, whoever's context it fires in. */
function starter(input: NewTaskRecord): string | null {
  const actor = input.scheduleId ? null : actorSnapshot();
  return actor ? JSON.stringify(actor) : null;
}

export function createTask(store: Store, input: NewTaskRecord): Task {
  return store.db.transaction(() => {
    const id = shortId("t");
    const scheduledAt = input.scheduledAt == null ? null : new Date(input.scheduledAt).toISOString();
    insertTask(store, input, id, scheduledAt);
    store.addEvent(id, "status", scheduledAt ? `Scheduled for ${scheduledAt}` : "Queued", {
      status: "queued", ...(scheduledAt ? { scheduledAt } : {}),
    });
    if (input.preApprove) store.addEvent(id, "operator", "Pre-approved", { preApproved: true });
    const task = store.getTask(id)!;
    const waiting = store.unmetPrerequisites(task);
    if (waiting.length) {
      store.addEvent(id, "note", `Waits for ${waiting.map((t) => t.id).join(", ")} to land before it starts`, {
        prerequisites: waiting.map((t) => t.id),
      });
    }
    return task;
  }).immediate();
}

export function getTask(store: Store, id: string): Task | null {
  // Accept a bare id too. Tasks created before the rename kept their `m-` prefix.
  const r = store.db
    .prepare("SELECT * FROM tasks WHERE id IN (?, ?, ?) ORDER BY id = ? DESC LIMIT 1")
    .get(id, `t-${id}`, `m-${id}`, id) as Row | undefined;
  return r ? toTask(r) : null;
}

export function listTasks(store: Store, opts: TaskListOptions = {}): Task[] {
  return taskListRows(store, "t.*", opts).map(toTask);
}

/** Select only what polled rows display, without loading briefs or parsing full reports in JS. */
export function listTaskSummaries(store: Store, opts: TaskListOptions = {}): TaskSummary[] {
  return taskListRows<TaskSummary>(store, TASK_SUMMARY_COLUMNS, opts);
}

function taskListRows<T = Row>(store: Store, columns: string, opts: TaskListOptions): T[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status?.length) {
    where.push(`status IN (${opts.status.map(() => "?").join(",")})`);
    params.push(...opts.status);
  }
  if (opts.repoId) {
    where.push("repo_id = ?");
    params.push(opts.repoId);
  }
  if (opts.assignee) {
    where.push("assignee = ?");
    params.push(opts.assignee);
  }
  // Pick the page from the index first, so keeping a few tasks doesn't read every match's brief and report.
  const sql = `SELECT ${columns} FROM (
                 SELECT rowid AS page_rowid FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC, rowid DESC LIMIT ?
               ) page
               CROSS JOIN tasks t ON t.rowid = page.page_rowid
               ORDER BY t.created_at DESC, t.rowid DESC`;
  params.push(opts.limit ?? 200);
  return store.db.prepare(sql).all(...params) as T[];
}

/** Tasks in one of these statuses that still have a worktree on record. */
export function tasksWithWorktrees(store: Store, statuses: TaskStatus[]): Task[] {
  if (!statuses.length) return [];
  const rows = store.db
    .prepare(`SELECT * FROM tasks WHERE worktree IS NOT NULL AND status IN (${statuses.map(() => "?").join(",")})`)
    .all(...statuses) as Row[];
  return rows.map(toTask);
}

export function updateTask(store: Store, id: string, patch: TaskPatch) {
  const cols: Readonly<Record<string, string>> = TASK_UPDATE_COLUMNS;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    params.push((k === "report" || k === "visualReview" || k === "reviewCheckpoint") && v ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  params.push(id);
  store.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function setStatus(store: Store, id: string, status: TaskStatus, message?: string, data?: Record<string, unknown>) {
  const patch: TaskPatch = { status };
  if (status === "running") patch.startedAt = now();
  // Waiting on the operator counts as finished: the agent's part is over.
  if (status === "needs_review" || FINISHED_STATUSES.includes(status)) patch.finishedAt = now();
  store.updateTask(id, patch);
  store.addEvent(id, "status", message ?? status, { ...data, status });
}

/** A status change that applies only while the task is still in one of `from`. */
export type StatusTransition = { from: TaskStatus[]; to: TaskStatus; message?: string; data?: Record<string, unknown> };

/**
 * Move a task to `to` only if it is still in one of `from`, writing the status
 * event as `setStatus` does, in one transaction. The conditional update is the
 * claim, so of several callers racing, in this process or another on the same
 * database, exactly one wins. Returns whether this caller won; a loser changes nothing.
 */
export function transitionStatus(store: Store, id: string, change: StatusTransition): boolean {
  if (!change.from.length) return false;
  return store.db.transaction(() => {
    const won = store.db
      .prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status IN (${change.from.map(() => "?").join(",")})`)
      .run(change.to, id, ...change.from).changes > 0;
    if (won) setStatus(store, id, change.to, change.message, change.data);
    return won;
  }).immediate();
}
