import {
  driverLabel,
  MAINTENANCE_ROLE,
  type Agent,
  type MaintenanceRole,
  type MaintenanceRoleInfo,
  type Overview,
  type TaskSummary,
} from "@crane/contracts";

export type CrewInput = { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null };

/** One member as the page shows it: what they're on, and what's waiting for them. */
export interface Member {
  a: Agent;
  role: MaintenanceRoleInfo | null;
  /** The task they're working right now. */
  doing: TaskSummary | null;
  /** A run started for this member that they haven't picked up yet. */
  waiting: TaskSummary | null;
}

/** The crew as the page groups it. */
export interface CrewRoster {
  members: Member[];
  /** Working members first, then those with a run waiting, then the free ones. */
  active: Member[];
  onCall: Member[];
  working: number;
  free: number;
  queuedForAnyone: number;
  /** Who to offer when queued work has no one free to take it. Null when nothing needs fixing. */
  spare: Member | null;
}

/** What the roster reads from the overview. */
export type CrewOverview = Pick<Overview, "agents" | "inFlight" | "queuedForAnyone"> & {
  factory: Pick<Overview["factory"], "running" | "paused">;
};

/** Members still finishing a task stay with the active ones until it's done. */
export const isOnCall = (a: Agent) => !a.active && a.state !== "working";

function toMember(a: Agent, inFlight: TaskSummary[]): Member {
  const doing = a.taskId ? inFlight.find((t) => t.id === a.taskId) ?? null : null;
  const waiting = doing ? null : inFlight.find((t) => t.assignee === a.id && t.status === "queued") ?? null;
  return { a, role: a.role ? MAINTENANCE_ROLE[a.role] : null, doing, waiting };
}

function memberRank({ doing, waiting }: Member): number {
  if (doing) return 0;
  return waiting ? 1 : 2;
}

/** Sort the crew into the page's groups, and work out whether queued work needs someone activated. */
export function crewRoster({ agents, inFlight, queuedForAnyone, factory }: CrewOverview): CrewRoster {
  const members = agents.map((a) => toMember(a, inFlight));
  const active = members.filter((m) => !isOnCall(m.a)).sort((x, y) => memberRank(x) - memberRank(y));
  const onCall = members.filter((m) => isOnCall(m.a));
  const free = active.filter((m) => m.a.active && m.a.state === "idle" && !m.role && !m.waiting).length;
  const queued = queuedForAnyone ?? 0;
  const short = factory.running && !factory.paused && queued > 0 && free === 0;
  return {
    members,
    active,
    onCall,
    working: members.filter((m) => m.a.state === "working").length,
    free,
    queuedForAnyone: queued,
    spare: short ? onCall.find((m) => !m.role) ?? null : null,
  };
}

/** The short line under a member's name: their state, in the operator's words. */
export function memberStatus({ a, role, doing, waiting }: Member): string {
  const own = a.defaultDriver ? ` · ${driverLabel(a.defaultDriver)}` : "";
  const postmortems = a.runsPostmortems ? " · Runs post-mortems" : "";
  if (a.state === "working") {
    if (a.active) return `Working on ${driverLabel(a.driver)}`;
    return doing?.postmortemOf ? `Called in for a post-mortem on ${driverLabel(a.driver)}` : "Finishing current work, then on-call";
  }
  if (!a.active) return `On-call${postmortems}${role ? ` · ${role.label}` : ""}${own}`;
  if (a.state === "paused") return "Paused";
  if (role) return `${role.label}${waiting ? " · run queued" : ""}${postmortems}${own}`;
  return `Free${postmortems}${own}`;
}

/** How a crew change reads once it's saved. Nothing for a change that names none of these. */
export function crewChangeText(a: Agent, input: CrewInput): string | undefined {
  if (input.active) return `${a.name} is active`;
  if (input.active !== undefined) return a.state === "working" ? `${a.name} goes on-call after this task` : `${a.name} is on-call`;
  if (input.role !== undefined) return input.role ? `${a.name} now handles ${MAINTENANCE_ROLE[input.role].label.toLowerCase()}` : `${a.name} takes any queued task`;
  if (input.defaultDriver !== undefined) return input.defaultDriver ? `${a.name} runs on ${driverLabel(input.defaultDriver)}` : `${a.name} follows the factory default`;
  return undefined;
}
