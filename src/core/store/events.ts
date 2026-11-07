import type { CommandEvidence, EventType, TaskEvent } from "@crane/contracts";
import { actorSnapshot } from "../actor.js";
import type { Store } from "../store.js";
import { toEvent, type Row } from "./rows.js";
import { now } from "./shared.js";

/**
 * Operator events record who made them, as a snapshot of the current actor.
 * Callers that pass their own `actor` keep it; events with no actor in
 * context, such as schedules firing, stay unattributed.
 */
function attributed(type: EventType, data: Record<string, unknown> | null | undefined) {
  if (type !== "operator" || (data && "actor" in data)) return data;
  const actor = actorSnapshot();
  return actor ? { ...data, actor } : data;
}

export function addEvent(store: Store, taskId: string, type: EventType, message: string, rawData?: Record<string, unknown> | null): TaskEvent {
  const data = attributed(type, rawData);
  const ts = now();
  const info = store.db
    .prepare("INSERT INTO events(task_id, ts, type, message, data) VALUES(?, ?, ?, ?, ?)")
    .run(taskId, ts, type, message, data ? JSON.stringify(data) : null);
  return { id: Number(info.lastInsertRowid), taskId, ts, type, message, data: data ?? null };
}

export function listEvents(store: Store, taskId: string, afterId = 0): TaskEvent[] {
  return (
    store.db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC").all(taskId, afterId) as Row[]
  ).map(toEvent);
}

/** Bound the refusal history independently of noisy tool and command events. */
export function priorRefusals(store: Store, taskId: string): TaskEvent[] {
  return (store.db.prepare(
    "SELECT * FROM events WHERE task_id = ? AND type = 'blocked' ORDER BY id DESC LIMIT 40",
  ).all(taskId) as Row[]).reverse().map(toEvent);
}

/** Latest lifecycle event per command, bounded for the next agent's prompt. */
export function commandEvidence(store: Store, taskId: string): CommandEvidence[] {
  const rows = store.db.prepare(`
    SELECT e.data FROM events e
    WHERE e.task_id = ? AND e.type = 'tool' AND json_extract(e.data, '$.command.commandId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events later WHERE later.task_id = e.task_id AND later.id > e.id
          AND json_extract(later.data, '$.command.commandId') = json_extract(e.data, '$.command.commandId')
      )
    ORDER BY e.id DESC LIMIT 40
  `).all(taskId) as Row[];
  return rows.reverse().map((r) => (JSON.parse(r.data as string) as { command: CommandEvidence }).command);
}

/** A lost stream is not proof that its command failed (or even stopped). */
export function closeUnresolvedCommands(store: Store, taskId?: string) {
  const rows = store.db.prepare(`
    SELECT e.task_id, e.data FROM events e
    WHERE e.type = 'tool' AND json_extract(e.data, '$.command.status') = 'running'
      AND (? IS NULL OR e.task_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM events later WHERE later.task_id = e.task_id AND later.id > e.id
          AND json_extract(later.data, '$.command.commandId') = json_extract(e.data, '$.command.commandId')
      )
  `).all(taskId ?? null, taskId ?? null) as Row[];
  for (const r of rows) {
    const command = (JSON.parse(r.data as string) as { command: CommandEvidence }).command;
    store.addEvent(r.task_id as string, "tool", "Command outcome unknown after the agent stream stopped", {
      tool: "shell", command: { ...command, status: "unknown", exitCode: null },
    });
  }
}

/** Events across every task, for the live factory feed. */
export function eventsSince(store: Store, afterId: number, limit = 200): TaskEvent[] {
  return (store.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(afterId, limit) as Row[]).map(
    toEvent,
  );
}

export function latestEventId(store: Store): number {
  const r = store.db.prepare("SELECT MAX(id) AS id FROM events").get() as Row;
  return (r.id as number) ?? 0;
}
