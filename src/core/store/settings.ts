import { FINISHED_STATUSES, type PostmortemSettings, type RetentionSettings } from "@crane/contracts";
import type { Store } from "../store.js";
import type { Row } from "./rows.js";

// Operator settings, pause state, history retention and post-mortem choices.
export function getSetting(store: Store, key: string): string | null {
  const r = store.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return (r?.value as string) ?? null;
}

export function setSetting(store: Store, key: string, value: string) {
  store.db
    .prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function retentionSettings(store: Store): RetentionSettings {
  const days = Number(getSetting(store, "retention_finished_task_days"));
  return { finishedTaskDays: Number.isInteger(days) && days >= 1 && days <= 36500 ? days : null };
}

/**
 * Bounded batches; the predicate is checked under the same lock as deletion.
 * A post-mortem builds its prompt from its source task's events when it runs,
 * so a source keeps them while one is queued or running.
 */
export function pruneTaskHistory(store: Store, cutoff: string, days: number): number {
  return store.db.transaction(() => {
    const removed = store.db.prepare(`DELETE FROM events WHERE id IN (
      SELECT e.id FROM tasks t JOIN events e ON e.task_id = t.id
      WHERE t.status IN (${FINISHED_STATUSES.map(() => "?").join(",")})
        AND t.finished_at < ? AND e.ts < ?
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.outcome = 'running')
        AND t.id NOT IN (SELECT postmortem_of FROM tasks WHERE postmortem_of IS NOT NULL AND status IN ('queued', 'running'))
        AND (e.type = 'tool' OR (e.type = 'note'
          AND CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.routine') END = 1))
      ORDER BY e.id LIMIT 5000
    ) RETURNING task_id`).all(...FINISHED_STATUSES, cutoff, cutoff) as { task_id: string }[];
    const counts = new Map<string, number>();
    for (const r of removed) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
    for (const [id, count] of counts) store.addEvent(id, "note", `Trimmed ${count} routine history events under the ${days}-day retention setting`, {
      retention: { days, cutoff, events: count },
    });
    return removed.length;
  }).immediate();
}

/** The first opt-in sweep needs one full rewrite to convert older databases. */
export function vacuumHistory(store: Store): void {
  if (store.db.pragma("auto_vacuum", { simple: true }) !== 2) {
    store.db.pragma("auto_vacuum = INCREMENTAL");
    store.db.exec("VACUUM");
  }
  // Bounded reclamation on later sweeps, rather than another full VACUUM.
  store.db.pragma("incremental_vacuum(1000)");
}

function savedPostmortemSettings(store: Store): Partial<PostmortemSettings> {
  const saved = getSetting(store, "postmortem_settings");
  return saved ? JSON.parse(saved) as Partial<PostmortemSettings> : {};
}

export function postmortemSettings(store: Store): PostmortemSettings {
  const saved = savedPostmortemSettings(store);
  return { driver: saved.driver ?? null, model: saved.model ?? null, effort: saved.effort ?? null, crew: postmortemCrew(store) };
}

/**
 * Who the operator named to run post-mortems; empty leaves them to any active
 * member. Anyone who has left the crew drops out, so they can't strand a review.
 */
export function postmortemCrew(store: Store): string[] {
  const named = savedPostmortemSettings(store).crew ?? [];
  if (!named.length) return [];
  const crew = new Set((store.db.prepare("SELECT id FROM agents").all() as Row[]).map((a) => a.id));
  return named.filter((id) => crew.has(id));
}

export function setPostmortemSettings(store: Store, settings: PostmortemSettings) {
  setSetting(store, "postmortem_settings", JSON.stringify(settings));
}

export function isPaused(store: Store): boolean {
  return getSetting(store, "paused") === "1";
}

export function setPaused(store: Store, paused: boolean) {
  setSetting(store, "paused", paused ? "1" : "0");
}
