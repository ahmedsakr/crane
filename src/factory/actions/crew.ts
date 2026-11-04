import {
  MAINTENANCE_ROLE,
  crewScheduleLabel,
  driverLabel,
  type Agent,
  type MaintenanceRole,
  type Repo,
  type RoleRunOptions,
  type Task,
} from "@crane/contracts";
import { crewSettingKey, type Store } from "../../core/store.js";
import { checkDriver, checkRole } from "../action-inputs.js";
import { isAvailable, sharedDrivers } from "../drivers.js";
import { ensureFactoryRepo, needRepo } from "./repos.js";
import { preApprove } from "./review.js";
import { createTask } from "./tasks.js";

type RoleRunRequest = RoleRunOptions & { preApprove?: boolean; scheduleId?: string };

/**
 * Preferences apply to the next assignment; current work finishes normally.
 * A `role` dedicates the member to one kind of maintenance (null makes it a
 * general member again): from then on it takes only the runs started for it.
 */
export async function configureCrew(store: Store, id: string, input: { active?: boolean; defaultDriver?: string | null; role?: string | null }) {
  if (!store.listAgents().some((a) => a.id === id)) throw new Error(`No crew member ${id}`);
  if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("Active must be a boolean");
  const role = checkRole(input.role);
  const driver = checkDriver(input.defaultDriver);
  if (driver) {
    const d = sharedDrivers().find((d) => d.name === driver)!;
    if (!(await isAvailable(d))) throw new Error(`${driverLabel(driver)} isn't installed here`);
  }
  if (input.defaultDriver !== undefined) store.setSetting(crewSettingKey.defaultDriver(id), driver ?? "");
  if (input.active !== undefined) store.setSetting(crewSettingKey.active(id), String(input.active));
  if (input.role !== undefined) store.setSetting(crewSettingKey.role(id), role ?? "");
  return store.listAgents().find((a) => a.id === id)!;
}

/** The member a maintenance run is for, who must exist, have a role and be active. */
function runnableMember(store: Store, id: string): Agent & { role: MaintenanceRole } {
  const member = store.listAgents().find((a) => a.id === id);
  if (!member) throw new Error(`No crew member ${id}`);
  if (!member.role) throw new Error(`${member.name} has no maintenance role. Give them one first`);
  if (!member.active) throw new Error(`${member.name} is on-call. Activate them first, so the run doesn't wait in the queue`);
  return { ...member, role: member.role };
}

/**
 * Start a crew member's maintenance run, defaulting to Crane's own repo. The task is
 * assigned to that member, so only they pick it up, at their role's freedom.
 */
export async function runRole(store: Store, id: string, opts: RoleRunRequest = {}): Promise<Task> {
  runnableMember(store, id);
  if (opts.repoId !== undefined && (typeof opts.repoId !== "string" || !opts.repoId.trim())) {
    throw new Error("Choose a connected repo for this run");
  }
  const repo = opts.repoId === undefined ? await ensureFactoryRepo(store) : needRepo(store, opts.repoId);
  if (!repo) throw new Error("Crane's own repo isn't connected, so there's nothing to maintain");
  return store.transaction(() => createRoleRun(store, id, repo, opts), { immediate: true });
}

/** Create the run inside the caller's transaction, reading the member's policy again under its lock. */
export function createRoleRun(store: Store, id: string, repo: Repo, opts: RoleRunRequest): Task {
  const member = runnableMember(store, id);
  if (opts.scheduleId && (store.isPaused() || member.state === "paused")) throw new Error(`${member.name} is paused`);
  // Recurring slots skip any open run; manual runs may target another repo.
  const open = store.listTasks({
    status: opts.scheduleId ? ["queued", "running", "needs_review", "merging"] : ["queued", "running"],
    repoId: opts.scheduleId ? undefined : repo.id,
    assignee: member.id,
    limit: 1,
  })[0];
  if (open) throw new Error(`${member.name} already has a run under way: ${open.id} · ${open.title}`);

  const schedule = opts.scheduleId ? store.listCrewSchedules(id).find((s) => s.id === opts.scheduleId) : undefined;
  if (opts.scheduleId && !schedule) throw new Error("No such crew schedule");
  const role = MAINTENANCE_ROLE[member.role];
  const task = createTask(store, {
    kind: "maintenance",
    title: `${role.action} in ${repo.name}`,
    brief: `${role.brief}\n\nStarted from ${member.name}'s maintenance role: ${role.label}.`,
    repoId: repo.id,
    autonomy: role.autonomy,
    assignee: member.id,
    scheduledAt: opts.scheduledAt,
    scheduleId: schedule?.id,
  });
  store.addEvent(task.id, "operator", `Started ${member.name}'s ${role.label.toLowerCase()} run`, {
    agentId: member.id,
    role: member.role,
    repoId: repo.id,
  });
  if (schedule) {
    store.addEvent(task.id, "operator", `Started by ${member.name}'s ${crewScheduleLabel(schedule)} schedule`, { scheduleId: schedule.id });
  }
  return opts.preApprove ? preApprove(store, task.id) : store.getTask(task.id)!;
}
