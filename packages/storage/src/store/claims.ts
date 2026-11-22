import type { Task } from "@crane/contracts";
import type { Store } from "../store.js";
import { toTask, type Row } from "./rows.js";
import { now, TASK_DUE } from "./shared.js";

export type ClaimOptions = { onlyAssigned?: boolean; onlyPostmortems?: boolean };

/** What one tick may find to do. `runners` lists the containers with due queued work, which the crew never takes. */
export type PendingWork = { queued: boolean; merging: boolean; runners: string[] };

/** Read-only hint for one tick; claims still recheck under the write lock. */
export function pendingWork(store: Store): PendingWork {
  const at = now();
  const row = store.db.prepare(`SELECT
    EXISTS(SELECT 1 FROM tasks WHERE status = 'queued' AND runner_id IS NULL AND ${TASK_DUE}) AS queued,
    EXISTS(SELECT 1 FROM tasks WHERE status = 'merging' AND agent_id IS NULL) AS merging`)
    .get(at) as { queued: number; merging: number };
  const runners = store.db.prepare(`SELECT DISTINCT runner_id AS id FROM tasks
    WHERE status = 'queued' AND runner_id IS NOT NULL AND ${TASK_DUE} ORDER BY runner_id`).all(at) as { id: string }[];
  return { queued: !!row.queued, merging: !!row.merging, runners: runners.map((r) => r.id) };
}

/**
 * The SQL that limits a claim to tasks this agent may take, with its bindings.
 * Once the operator names a post-mortem crew, post-mortems go to them alone, and
 * `onlyPostmortems` limits a named member to those. Tasks routed to a container
 * are excluded separately, by `claimNextTask` itself.
 */
export function claimEligibility(agentId: string, crew: readonly string[], opts: ClaimOptions = {}): { sql: string; params: string[] } {
  if (opts.onlyPostmortems) return { sql: "postmortem_of IS NOT NULL", params: [] };
  const mine = opts.onlyAssigned ? "assignee = ?" : "(assignee IS NULL OR assignee = ?)";
  const params = [agentId];
  if (!crew.length) return { sql: mine, params };
  if (crew.includes(agentId)) return { sql: `(postmortem_of IS NOT NULL OR ${mine})`, params };
  return { sql: `(postmortem_of IS NULL AND ${mine})`, params };
}

/**
 * Atomically take the first queued task this agent may work: one assigned
 * to it, or one assigned to nobody unless `onlyAssigned`. Once the operator
 * names a post-mortem crew, post-mortems go to them alone, whatever their role;
 * `onlyPostmortems` is how a named member who's on-call gets called in. Never
 * takes a task routed to a container. Skips tasks whose start time hasn't
 * arrived or prerequisites haven't landed (unless waived). Safe if two factories race.
 */
export function claimNextTask(store: Store, agentId: string, opts: ClaimOptions = {}): Task | null {
  const crew = store.postmortemCrew();
  if (opts.onlyPostmortems && !crew.includes(agentId)) return null;
  const eligible = claimEligibility(agentId, crew, opts);
  return claimFirst(store, agentId, { sql: `runner_id IS NULL AND ${eligible.sql}`, params: eligible.params });
}

/**
 * Atomically take the first queued task routed to this container, for its
 * lane's `agentId`, with the crew's due, prerequisite and queue ordering.
 * Assignees and the post-mortem crew don't apply: the container is the routing.
 */
export function claimNextRunnerTask(store: Store, runnerId: string, agentId: string): Task | null {
  return claimFirst(store, agentId, { sql: "runner_id = ?", params: [runnerId] });
}

/**
 * Claim the first due, queued task matching `where` whose prerequisites have
 * landed. Immediate because it reads, then writes: a deferred transaction fails
 * at once, without waiting for busy_timeout, if another process commits between them.
 */
function claimFirst(store: Store, agentId: string, where: { sql: string; params: string[] }): Task | null {
  return store.db.transaction(() => {
    const rows = store.db
      .prepare(`SELECT * FROM tasks WHERE status = 'queued' AND ${where.sql}
        AND ${TASK_DUE} ORDER BY queue_position, created_at, rowid`)
      .all(...where.params, now()) as Row[];
    const next = rows.map(toTask).find((t) => !store.unmetPrerequisites(t).length);
    if (!next) return null;
    const changed = store.db
      .prepare("UPDATE tasks SET status = 'running', agent_id = ?, started_at = ? WHERE id = ? AND status = 'queued'")
      .run(agentId, now(), next.id).changes;
    if (!changed) return null;
    store.addEvent(next.id, "status", "Picked up", { status: "running", agentId });
    return store.getTask(next.id);
  }).immediate();
}

/**
 * Atomically take the oldest task waiting to merge. Skips repos that already
 * have a merge in progress, so two merges never race for the same branch.
 */
export function claimNextMerge(store: Store, agentId: string, busyRepoIds: string[] = []): Task | null {
  return store.db.transaction(() => {
    const skip = busyRepoIds.length ? `AND repo_id NOT IN (${busyRepoIds.map(() => "?").join(",")})` : "";
    const r = store.db
      .prepare(`SELECT id FROM tasks WHERE status = 'merging' AND agent_id IS NULL ${skip} ORDER BY finished_at ASC LIMIT 1`)
      .get(...busyRepoIds) as Row | undefined;
    if (!r) return null;
    const changed = store.db
      .prepare("UPDATE tasks SET agent_id = ? WHERE id = ? AND status = 'merging' AND agent_id IS NULL")
      .run(agentId, r.id).changes;
    if (!changed) return null;
    store.addEvent(r.id as string, "note", "Picked up to merge", { agentId });
    return store.getTask(r.id as string);
  }).immediate();
}
