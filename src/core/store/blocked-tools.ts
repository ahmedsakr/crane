import type Database from "better-sqlite3";
import { isReasonedRefusal, ruleLabel, type BlockedTool, type RepoTools } from "@crane/contracts";
import type { Row } from "./rows.js";

export type BlockedToolsOptions = { repoId?: string; taskId?: string; minTasks?: number };

/** Per-store totals, invalidated by the count and latest id of blocked events. */
export class BlockedToolsReader {
  private cache: { version: string; rows: Row[] } | null = null;

  private refusalTotals(db: Database.Database): Row[] {
    const latest = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS id FROM events WHERE type = 'blocked'").get() as Row;
    const version = `${latest.n}:${latest.id}`;
    if (this.cache?.version === version) return this.cache.rows;
    // SQLite takes bare columns from the row holding the only MAX(), so ts, task_id and the refusal all describe the latest one.
    const rows = db.prepare(
      `SELECT t.repo_id AS repo_id, p.name AS repo_name, r.value AS rule,
                COUNT(DISTINCT e.task_id) AS tasks, COUNT(*) AS times,
                MAX(e.id) AS last_id, e.ts AS last_at, e.task_id AS last_task_id,
                json_extract(e.data, '$.refusal.source') AS refusal_source,
                json_extract(e.data, '$.refusal.reason') AS refusal_reason
         FROM events e
         JOIN tasks t ON t.id = e.task_id
         JOIN repos p ON p.id = t.repo_id
         , json_each(e.data, '$.rules') r
         WHERE e.type = 'blocked'
         GROUP BY t.repo_id, r.value
         ORDER BY tasks DESC, last_at DESC`,
    ).all() as Row[];
    this.cache = { version, rows };
    return rows;
  }

  read(db: Database.Database, repoTools: (id: string) => RepoTools, opts: BlockedToolsOptions): BlockedTool[] {
    // Every task's count, but only for rules this task hit.
    const taskRules = opts.taskId ? new Set(
      (db.prepare("SELECT r.value AS rule FROM events e, json_each(e.data, '$.rules') r WHERE e.task_id = ? AND e.type = 'blocked'")
        .all(opts.taskId) as Row[]).map((r) => r.rule),
    ) : null;
    const rows = this.refusalTotals(db).filter((r) =>
      (!opts.repoId || r.repo_id === opts.repoId)
      && (r.tasks as number) >= (opts.minTasks ?? 1)
      && (!taskRules || taskRules.has(r.rule)));
    const decided = new Map<string, Set<string>>();
    const isDecided = (repoId: string, rule: string) => {
      if (!decided.has(repoId)) {
        const tools = repoTools(repoId);
        decided.set(repoId, new Set([...tools.allowed, ...tools.keptBlocked]));
      }
      return decided.get(repoId)!.has(rule);
    };
    return rows.filter((r) => !isDecided(r.repo_id as string, r.rule as string)).map(toBlockedTool);
  }
}

function toBlockedTool(r: Row): BlockedTool {
  return {
    repoId: r.repo_id as string,
    repoName: r.repo_name as string,
    rule: r.rule as string,
    label: ruleLabel(r.rule as string),
    tasks: r.tasks as number,
    times: r.times as number,
    lastAt: r.last_at as string,
    lastTaskId: r.last_task_id as string,
    ...latestRefusal(r),
  };
}

/** The latest refusal's reason, only when Crane's guard or auto mode gave one. */
function latestRefusal(r: Row): Pick<BlockedTool, "refusal"> {
  if (!isReasonedRefusal(r.refusal_source)) return {};
  return { refusal: { source: r.refusal_source, reason: typeof r.refusal_reason === "string" ? r.refusal_reason : null } };
}
