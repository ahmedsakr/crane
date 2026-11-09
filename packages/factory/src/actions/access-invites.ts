import { actorLabel, type EventActor, type InviteCheck, type InviteSummary } from "@crane/contracts";
import type { InviteRecord, NewInvite } from "@crane/storage";
import { hashPassword, newToken, tokenDigest } from "../auth-crypto.js";
import { AccessError } from "./access-errors.js";
import {
  EXPIRED_LINK,
  JOIN_LINK_MS,
  RESET_LINK_MS,
  asAdmin,
  checkName,
  checkPassword,
  checkRole,
  checkUsername,
  iso,
  needOperator,
  refuseTakenUsername,
  requireAdmin,
  type AccessDeps,
} from "./access-rules.js";
import { startSession, type SignedIn } from "./access-sessions.js";

/**
 * Single-use links: a join link adds an operator (7 days), and a reset link
 * sets an existing operator's password (24 hours). The token is returned
 * once, when the link is made; only its digest is kept.
 */

export type IssuedInvite = { invite: InviteSummary; token: string };
export type AcceptInput = { username?: unknown; name?: unknown; password?: unknown };

function issue(deps: AccessDeps, by: EventActor, fields: Omit<NewInvite, "tokenHash" | "at" | "createdBy">): IssuedInvite {
  const token = newToken();
  const record = deps.store.access.createInvite({ ...fields, tokenHash: tokenDigest(token), at: iso(deps.now()), createdBy: actorLabel(by) });
  return { invite: deps.store.access.inviteSummary(record.id)!, token };
}

export function inviteOperator(deps: AccessDeps, by: EventActor, input: { role: unknown; name?: unknown }): IssuedInvite {
  const role = checkRole(input?.role);
  const name = input?.name === undefined || input.name === null || input.name === "" ? null : checkName(input.name);
  return asAdmin(deps.store, by, () =>
    issue(deps, by, { kind: "join", role, name, operatorId: null, expiresAt: iso(deps.now() + JOIN_LINK_MS) }));
}

/** Replaces any reset link the operator already has. */
export function createPasswordReset(deps: AccessDeps, by: EventActor, operatorId: string): IssuedInvite {
  return asAdmin(deps.store, by, () => {
    needOperator(deps.store, operatorId);
    deps.store.access.deletePendingResets(operatorId);
    return issue(deps, by, { kind: "reset", role: null, name: null, operatorId, expiresAt: iso(deps.now() + RESET_LINK_MS) });
  });
}

export function listInvites(deps: AccessDeps, by: EventActor): InviteSummary[] {
  requireAdmin(deps.store, by);
  return deps.store.access.listPendingInvites(iso(deps.now()));
}

export function revokeInvite(deps: AccessDeps, by: EventActor, id: string): void {
  asAdmin(deps.store, by, () => {
    if (!deps.store.access.deletePendingInvite(id)) throw new Error(`No pending link ${String(id)}`);
  });
}

/** An unused, unexpired link, or the same 401 for anything else. */
function pendingInvite(deps: AccessDeps, token: unknown): InviteRecord {
  const invite = typeof token === "string" && token ? deps.store.access.inviteByTokenHash(tokenDigest(token)) : null;
  if (!invite || invite.usedAt || Date.parse(invite.expiresAt) <= deps.now()) throw new AccessError(401, EXPIRED_LINK);
  if (invite.kind === "reset" && !invite.operatorId) throw new AccessError(401, EXPIRED_LINK);
  return invite;
}

export function checkInvite(deps: AccessDeps, token: unknown): InviteCheck {
  const invite = pendingInvite(deps, token);
  const target = invite.operatorId ? needOperator(deps.store, invite.operatorId) : null;
  return {
    kind: invite.kind,
    role: invite.role,
    name: target?.name ?? invite.name,
    username: target?.username ?? null,
    invitedBy: invite.createdBy,
    expiresAt: invite.expiresAt,
  };
}

/**
 * Use a link and sign this device in. A join link creates the operator with
 * the link's role; a reset link sets the operator's password and signs out
 * their other devices, ignoring any username given.
 */
export async function acceptInvite(deps: AccessDeps, token: unknown, input: AcceptInput, opts: { client?: unknown } = {}): Promise<SignedIn> {
  const invite = pendingInvite(deps, token);
  const password = checkPassword(input?.password);
  const join = invite.kind === "join"
    ? { username: checkUsername(input?.username), name: checkName(input?.name || invite.name) }
    : null;
  if (join) refuseTakenUsername(deps.store, join.username);
  const passwordHash = await hashPassword(password);
  return deps.store.transaction(() => {
    const fresh = pendingInvite(deps, token);
    const at = iso(deps.now());
    if (!deps.store.access.markInviteUsed(fresh.id, at)) throw new AccessError(401, EXPIRED_LINK);
    if (join) {
      refuseTakenUsername(deps.store, join.username);
      const operator = deps.store.access.createOperator({ ...join, role: fresh.role ?? "operator", passwordHash, at });
      return startSession(deps, operator.id, opts.client);
    }
    const operatorId = needOperator(deps.store, fresh.operatorId!).id;
    deps.store.access.setPassword(operatorId, passwordHash, at);
    deps.store.access.deleteSessionsFor(operatorId);
    return startSession(deps, operatorId, opts.client);
  }, { immediate: true });
}
