import type { CrewSchedule, CrewScheduleInput } from "@crane/contracts";
import type { Store } from "../store.js";
import type { Row } from "./rows.js";

// Recurring schedules that queue a crew member's maintenance work.
export function listCrewSchedules(store: Store, agentId?: string): CrewSchedule[] {
  const rows = store.db.prepare(`SELECT * FROM crew_schedules ${agentId ? "WHERE agent_id = ?" : ""} ORDER BY next_fire_at, id`)
    .all(...(agentId ? [agentId] : [])) as Row[];
  return rows.map(toCrewSchedule);
}

function toCrewSchedule(r: Row): CrewSchedule {
  return {
    id: r.id as string, agentId: r.agent_id as string, repoId: r.repo_id as string,
    daysMask: r.days_mask as number, localTime: r.local_time as string, timezone: r.timezone as string,
    preApprove: !!r.pre_approve, enabled: !!r.enabled, nextFireAt: r.next_fire_at as string,
    lastFiredAt: r.last_fired_at as string | null, lastOutcome: r.last_outcome as string | null,
  };
}

export function saveCrewSchedule(store: Store, id: string, agentId: string, input: CrewScheduleInput, nextFireAt: string): CrewSchedule {
  store.db.prepare(`INSERT INTO crew_schedules(id, agent_id, repo_id, days_mask, local_time, timezone, pre_approve, enabled, next_fire_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    repo_id=excluded.repo_id, days_mask=excluded.days_mask, local_time=excluded.local_time,
    timezone=excluded.timezone, pre_approve=excluded.pre_approve, enabled=excluded.enabled, next_fire_at=excluded.next_fire_at`)
    .run(id, agentId, input.repoId, input.daysMask, input.localTime, input.timezone, +input.preApprove, +input.enabled, nextFireAt);
  return listCrewSchedules(store, agentId).find((s) => s.id === id)!;
}

export function removeCrewSchedule(store: Store, id: string): void {
  store.db.prepare("DELETE FROM crew_schedules WHERE id = ?").run(id);
}

/** Must run inside the same transaction as task creation and outcome recording. */
export function claimCrewSchedule(store: Store, s: CrewSchedule, next: string, firedAt: string): boolean {
  return !!store.db.prepare(`UPDATE crew_schedules SET next_fire_at = ?, last_fired_at = ?
    WHERE id = ? AND enabled = 1 AND next_fire_at = ?`).run(next, firedAt, s.id, s.nextFireAt).changes;
}

export function crewScheduleOutcome(store: Store, id: string, outcome: string): void {
  store.db.prepare("UPDATE crew_schedules SET last_outcome = ? WHERE id = ?").run(outcome, id);
}
