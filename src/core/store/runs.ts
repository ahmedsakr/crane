import type { AgentRun, RunKind, RunOutcome, RunUsage } from "@crane/contracts";
import type { Store } from "../store.js";
import { toRun, type Row } from "./rows.js";
import { now } from "./shared.js";

// What each agent run cost.
export function startRun(store: Store, input: { taskId: string; kind: RunKind; agentId: string | null; driver: string }): number {
  const info = store.db
    .prepare("INSERT INTO runs(task_id, kind, agent_id, driver, started_at) VALUES(?, ?, ?, ?, ?)")
    .run(input.taskId, input.kind, input.agentId, input.driver, now());
  return Number(info.lastInsertRowid);
}

/**
 * Close a run and add what it cost to its task, in one transaction so the
 * task's total always equals the sum of its runs. `usage` is null when the
 * run ended before its driver could say (e.g. it was killed).
 */
export function finishRun(store: Store, id: number, outcome: Exclude<RunOutcome, "running">, usage: RunUsage | null) {
  const u = usage ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, model: null };
  const cost = Number.isFinite(u.costUsd) && u.costUsd > 0 ? u.costUsd : 0;
  const costStatus = !usage || !Number.isFinite(u.costUsd) || u.costUsd < 0 ? "unknown" : u.costStatus ?? "reported";
  store.db.transaction(() => {
    const run = store.db
      .prepare(
        `UPDATE runs SET outcome = ?, finished_at = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
           cache_read_tokens = ?, cache_write_tokens = ?, turns = ?, model = COALESCE(?, model), cost_status = ?
         WHERE id = ? AND outcome = 'running' RETURNING task_id`,
      )
      .get(outcome, now(), cost, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.turns, u.model, costStatus, id) as
      | Row
      | undefined;
    // Already closed (say, by a restarted factory): don't count its cost twice.
    if (run && cost) store.db.prepare("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?").run(cost, run.task_id);
  })();
}

/** Runs a dead factory left open retain their unknown cost status. */
export function closeStaleRuns(store: Store): number {
  return store.db.prepare("UPDATE runs SET outcome = 'cancelled', finished_at = ? WHERE outcome = 'running'").run(now()).changes;
}

export function listRuns(store: Store, taskId: string): AgentRun[] {
  return (store.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id ASC").all(taskId) as Row[]).map(toRun);
}

/** The driver of the task's latest work run, which owns its session. Null before its first run. */
export function lastWorkDriver(store: Store, taskId: string): string | null {
  const r = store.db
    .prepare("SELECT driver FROM runs WHERE task_id = ? AND kind = 'work' ORDER BY id DESC LIMIT 1")
    .get(taskId) as Row | undefined;
  return (r?.driver as string) ?? null;
}
