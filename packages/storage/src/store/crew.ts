import { isMaintenanceRole, type Agent, type AgentState, type MaintenanceRole } from "@crane/contracts";
import type { Store } from "../store.js";
import { toAgent, type Row } from "./rows.js";
import { getSetting, postmortemCrew } from "./settings.js";
import { now } from "./shared.js";

/** The settings that hold the operator's choices for one crew member. */
export const crewSettingKey = {
  active: (agentId: string) => `crew_active_${agentId}`,
  defaultDriver: (agentId: string) => `crew_driver_${agentId}`,
  role: (agentId: string) => `crew_role_${agentId}`,
};

// Crew members: the agents rows plus the operator's settings for each.
export function listAgents(store: Store): Agent[] {
  const named = postmortemCrew(store);
  return (store.db.prepare("SELECT * FROM agents ORDER BY name").all() as Row[]).map((r) => {
    const agent = toAgent(r);
    return {
      ...agent,
      active: crewActive(store, agent.id),
      defaultDriver: crewDefaultDriver(store, agent.id),
      role: crewRole(store, agent.id),
      runsPostmortems: named.includes(agent.id),
    };
  });
}

/**
 * Whether a crew member takes work. Members are active unless the operator put
 * them on-call, where they take only the post-mortems they're named for.
 */
export function crewActive(store: Store, agentId: string): boolean {
  return getSetting(store, crewSettingKey.active(agentId)) !== "false";
}

/** The agent a crew member prefers to run on, or null to follow the factory's default. */
export function crewDefaultDriver(store: Store, agentId: string): string | null {
  return getSetting(store, crewSettingKey.defaultDriver(agentId)) || null;
}

/** The maintenance a crew member is dedicated to, or null for a general member. */
export function crewRole(store: Store, agentId: string): MaintenanceRole | null {
  const role = getSetting(store, crewSettingKey.role(agentId));
  return isMaintenanceRole(role) ? role : null;
}

export function upsertAgent(store: Store, a: Pick<Agent, "id" | "name" | "driver">) {
  store.db
    .prepare(
      `INSERT INTO agents(id, name, driver) VALUES(?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, driver = excluded.driver`,
    )
    .run(a.id, a.name, a.driver);
}

export function setAgentState(store: Store, id: string, state: AgentState, taskId: string | null) {
  store.db
    .prepare(`UPDATE agents SET state = ?, task_id = ?, last_active_at =
      CASE WHEN state = 'working' OR ? = 'working' THEN ? ELSE last_active_at END
      WHERE id = ? AND (state IS NOT ? OR task_id IS NOT ?)`)
    .run(state, taskId, state, now(), id, state, taskId);
}

/** Which agent a crew member is running on right now. It changes with each task's choice. */
export function setAgentDriver(store: Store, id: string, driver: string) {
  store.db.prepare("UPDATE agents SET driver = ? WHERE id = ?").run(driver, id);
}

export function bumpAgentCompleted(store: Store, id: string) {
  store.db.prepare("UPDATE agents SET tasks_completed = tasks_completed + 1 WHERE id = ?").run(id);
}

/** Remove agents outside the current crew, keeping any that are still working. */
export function pruneAgents(store: Store, keepIds: string[]) {
  if (!keepIds.length) return;
  store.db
    .prepare(`DELETE FROM agents WHERE id NOT IN (${keepIds.map(() => "?").join(",")}) AND state != 'working'`)
    .run(...keepIds);
}
