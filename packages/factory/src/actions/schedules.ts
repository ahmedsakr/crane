import {
  MAINTENANCE_ROLE,
  errorMessage,
  nextCrewFire,
  validateCrewSchedule,
  type CrewSchedule,
  type CrewScheduleInput,
} from "@crane/contracts";
import { shortId } from "@crane/backend-runtime";
import type { Store } from "@crane/storage";
import { createRoleRun } from "./crew.js";
import { requireExistingRunnerOwner, resolveTaskRunner } from "./runners.js";

export function listCrewSchedules(store: Store, agentId?: string): CrewSchedule[] {
  if (agentId && !store.listAgents().some((a) => a.id === agentId)) throw new Error(`No crew member ${agentId}`);
  return store.listCrewSchedules(agentId);
}

export function saveCrewSchedule(store: Store, agentId: string, input: CrewScheduleInput, id?: string): CrewSchedule {
  validateCrewSchedule(input);
  return store.transaction(() => saveSchedule(store, agentId, input, id), { immediate: true });
}

function saveSchedule(store: Store, agentId: string, input: CrewScheduleInput, id?: string): CrewSchedule {
  const member = store.listAgents().find((a) => a.id === agentId);
  if (!member) throw new Error(`No crew member ${agentId}`);
  if (!member.role && input.enabled) throw new Error(`${member.name} has no maintenance role. Give them one first`);
  const repo = store.getRepo(input.repoId);
  if (!repo) throw new Error(`No repo ${input.repoId}`);
  const previous = id ? listCrewSchedules(store, agentId).find((s) => s.id === id) : undefined;
  if (id && !previous) throw new Error("No such crew schedule");
  if (input.enabled && input.preApprove && member.role && MAINTENANCE_ROLE[member.role].autonomy === "observe") throw new Error("Investigate-only runs cannot be pre-approved");
  requireExistingRunnerOwner(store, previous?.runnerId ?? null);
  let runnerId = previous?.runnerId ?? null;
  if (!previous || (input.runnerId !== undefined && input.runnerId !== runnerId)) runnerId = resolveTaskRunner(store, input.runnerId);
  return store.saveCrewSchedule(id ?? shortId("cs"), agentId, { ...input, repoId: repo.id, runnerId }, nextCrewFire(input, Date.now()));
}

export function removeCrewSchedule(store: Store, agentId: string, id: string): void {
  store.transaction(() => {
    const schedule = listCrewSchedules(store, agentId).find((s) => s.id === id);
    if (!schedule) throw new Error("No such crew schedule");
    requireExistingRunnerOwner(store, schedule.runnerId);
    store.removeCrewSchedule(id);
  }, { immediate: true });
}

/** Catch up once. Claim, creation and outcome commit together, including across processes. */
export function fireCrewSchedules(store: Store, at = Date.now()): void {
  const firedAt = new Date(at).toISOString();
  for (const due of store.listCrewSchedules().filter((s) => s.enabled && s.nextFireAt <= firedAt)) {
    store.transaction(() => {
      // Read policy again under the write lock: an edit or pause may have
      // happened since the due list was read by this process.
      const s = store.listCrewSchedules().find((s) => s.id === due.id);
      if (!s || !s.enabled || s.nextFireAt > firedAt) return;
      if (!store.claimCrewSchedule(s, nextCrewFire(s, at), firedAt)) return;
      try {
        // A savepoint rolls back task creation too if pre-approval fails.
        const task = store.transaction(() => {
          const repo = store.getRepo(s.repoId);
          if (!repo) throw new Error("Repo is no longer connected");
          return createRoleRun(store, s.agentId, repo, { preApprove: s.preApprove }, s);
        });
        store.crewScheduleOutcome(s.id, `Queued ${task.id}`);
      } catch (err) {
        store.crewScheduleOutcome(s.id, `Skipped: ${errorMessage(err)}`);
      }
    }, { immediate: true });
  }
}
