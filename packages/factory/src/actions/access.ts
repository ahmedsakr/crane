import type { EventActor, OperatorProfile, OperatorRole, OperatorSummary } from "@crane/contracts";
import type { SessionListing } from "@crane/storage";
import { hashPassword } from "../auth-crypto.js";
import {
  LAST_ADMIN,
  asAdmin,
  checkName,
  checkPassword,
  checkRole,
  checkUsername,
  iso,
  liveWindow,
  needOperator,
  profile,
  refuseTakenUsername,
  requireAdmin,
  requireHost,
  type AccessDeps,
} from "./access-rules.js";

/**
 * Managing operators. Admin actions take the actor asking: the host (anyone
 * running crane on the factory's machine) counts as an admin, and an operator
 * must be one. Host-only actions are ones a remote browser must never reach.
 */

export type NewOperatorInput = { username: unknown; name: unknown; role: unknown; password: unknown };

/** Host only: the first admin, or an operator added without an invite. */
export async function addOperator(deps: AccessDeps, by: EventActor, input: NewOperatorInput): Promise<OperatorProfile> {
  requireHost(by);
  const username = checkUsername(input?.username);
  const name = checkName(input?.name);
  const role = checkRole(input?.role);
  const password = checkPassword(input?.password);
  refuseTakenUsername(deps.store, username);
  const passwordHash = await hashPassword(password);
  return deps.store.transaction(() => {
    refuseTakenUsername(deps.store, username);
    if (role !== "admin" && deps.store.access.countAdmins() === 0) throw new Error("Make the first operator an admin");
    return profile(deps.store.access.createOperator({ username, name, role, passwordHash, at: iso(deps.now()) }));
  }, { immediate: true });
}

export function listOperators(deps: AccessDeps): OperatorSummary[] {
  return deps.store.access.listOperators(liveWindow(deps.now()));
}

/** Host only, for recovery: signs that operator out everywhere. */
export async function setOperatorPassword(deps: AccessDeps, by: EventActor, operatorId: string, password: unknown): Promise<OperatorProfile> {
  requireHost(by);
  const clean = checkPassword(password);
  needOperator(deps.store, operatorId);
  const passwordHash = await hashPassword(clean);
  return deps.store.transaction(() => {
    needOperator(deps.store, operatorId);
    deps.store.access.setPassword(operatorId, passwordHash, iso(deps.now()));
    deps.store.access.deleteSessionsFor(operatorId);
    return profile(needOperator(deps.store, operatorId));
  }, { immediate: true });
}

/** Refuses to leave the factory without an admin. */
export function setOperatorRole(deps: AccessDeps, by: EventActor, id: string, role: unknown): OperatorProfile {
  const next: OperatorRole = checkRole(role);
  return asAdmin(deps.store, by, () => {
    const operator = needOperator(deps.store, id);
    if (operator.role === next) return profile(operator);
    if (operator.role === "admin" && deps.store.access.countAdmins() <= 1) throw new Error(LAST_ADMIN);
    deps.store.access.setRole(id, next);
    return profile(needOperator(deps.store, id));
  });
}

/** Their sessions and invites go with them. Refuses to remove the last admin. */
export function removeOperator(deps: AccessDeps, by: EventActor, id: string): void {
  asAdmin(deps.store, by, () => {
    const operator = needOperator(deps.store, id);
    if (operator.role === "admin" && deps.store.access.countAdmins() <= 1) throw new Error(LAST_ADMIN);
    deps.store.access.deleteOperator(id);
  });
}

/** Signs an operator out on every device, and says how many. */
export function signOutOperator(deps: AccessDeps, by: EventActor, id: string): number {
  return asAdmin(deps.store, by, () => {
    needOperator(deps.store, id);
    return deps.store.access.deleteSessionsFor(id);
  });
}

/** Every signed-in device, for `crane auth devices`. */
export function listAllSessions(deps: AccessDeps, by: EventActor): SessionListing[] {
  requireAdmin(deps.store, by);
  return deps.store.access.listAllSessions(liveWindow(deps.now()));
}

export function signOutSessionById(deps: AccessDeps, by: EventActor, id: string): void {
  asAdmin(deps.store, by, () => {
    if (!deps.store.access.deleteSession(id)) throw new Error(`No signed-in device ${String(id)}`);
  });
}

/** Host only: turns sign-in off again by removing every operator, session and invite. */
export function clearAccess(deps: AccessDeps, by: EventActor): void {
  requireHost(by);
  deps.store.access.clear();
}

/** Removes sessions and links that have expired. */
export function pruneAccess(deps: AccessDeps): { sessions: number; invites: number } {
  const live = liveWindow(deps.now());
  return deps.store.transaction(() => ({
    sessions: deps.store.access.pruneSessions(live),
    invites: deps.store.access.pruneInvites(live.now),
  }));
}
