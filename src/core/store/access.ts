import type Database from "better-sqlite3";
import type { InviteSummary, OperatorProfile, OperatorRole, OperatorSession, OperatorSummary } from "@crane/contracts";
import { shortId } from "@crane/backend-runtime";
import type { Row } from "./rows.js";

/** An operator with what only the factory reads: their password hash. */
export type OperatorRecord = OperatorProfile & { passwordHash: string; passwordChangedAt: string };
export type SessionRecord = Omit<OperatorSession, "current">;
/** A session with whose it is, for the host's list of every signed-in device. */
export type SessionListing = OperatorSession & { username: string; operatorName: string };
export type InviteRecord = {
  id: string;
  kind: InviteSummary["kind"];
  role: OperatorRole | null;
  name: string | null;
  operatorId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};
export type NewOperator = { username: string; name: string; role: OperatorRole; passwordHash: string; at: string };
export type NewSession = { operatorId: string; tokenHash: string; at: string; expiresAt: string; client: string | null };
export type NewInvite = Pick<InviteRecord, "kind" | "role" | "name" | "operatorId" | "createdBy" | "expiresAt"> & { tokenHash: string; at: string };
/** Sessions count as signed in when they expire after `now` and were last seen after `idleSince`. */
export type LiveWindow = { now: string; idleSince: string };

const LAST_SEEN = "(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.operator_id = o.id) AS last_seen_at";
const LIVE = "expires_at > @now AND last_seen_at > @idleSince";

function toProfile(r: Row): OperatorProfile {
  return {
    id: r.id as string,
    username: r.username as string,
    name: r.name as string,
    role: r.role as OperatorRole,
    createdAt: r.created_at as string,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  };
}

const toOperator = (r: Row): OperatorRecord =>
  ({ ...toProfile(r), passwordHash: r.password_hash as string, passwordChangedAt: r.password_changed_at as string });

function toSession(r: Row): SessionRecord {
  return {
    id: r.id as string,
    operatorId: r.operator_id as string,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    expiresAt: r.expires_at as string,
    client: (r.client as string | null) ?? null,
  };
}

function toInvite(r: Row): InviteRecord {
  return {
    id: r.id as string,
    kind: r.kind as InviteRecord["kind"],
    role: (r.role as OperatorRole | null) ?? null,
    name: (r.name as string | null) ?? null,
    operatorId: (r.operator_id as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    usedAt: (r.used_at as string | null) ?? null,
  };
}

function toInviteSummary(r: Row): InviteSummary {
  const invite = toInvite(r);
  const forOperator = invite.operatorId && r.for_username
    ? { id: invite.operatorId, username: r.for_username as string, name: r.for_name as string }
    : null;
  return {
    id: invite.id, kind: invite.kind, role: invite.role, name: invite.name, forOperator,
    invitedBy: invite.createdBy, createdAt: invite.createdAt, expiresAt: invite.expiresAt,
  };
}

/**
 * Operators, sessions and invites, reached through `store.access`. Only
 * digests of tokens reach these tables; callers hash before asking.
 */
export class AccessStore {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // Operators

  createOperator(input: NewOperator): OperatorRecord {
    const id = shortId("o");
    this.db.prepare(`INSERT INTO operators(id, username, name, role, password_hash, created_at, password_changed_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, input.username, input.name, input.role, input.passwordHash, input.at, input.at);
    return this.operatorById(id)!;
  }

  operatorById(id: string): OperatorRecord | null {
    const r = this.db.prepare(`SELECT o.*, ${LAST_SEEN} FROM operators o WHERE o.id = ?`).get(id) as Row | undefined;
    return r ? toOperator(r) : null;
  }

  /** Usernames compare without case. */
  operatorByUsername(username: string): OperatorRecord | null {
    const r = this.db.prepare(`SELECT o.*, ${LAST_SEEN} FROM operators o WHERE o.username = ? COLLATE NOCASE`).get(username) as Row | undefined;
    return r ? toOperator(r) : null;
  }

  listOperators(live: LiveWindow): OperatorSummary[] {
    const rows = this.db.prepare(`SELECT o.*, ${LAST_SEEN},
        (SELECT COUNT(*) FROM sessions s WHERE s.operator_id = o.id AND ${LIVE}) AS devices
      FROM operators o ORDER BY o.created_at, o.username`).all(live) as Row[];
    return rows.map((r) => ({ ...toProfile(r), devices: r.devices as number }));
  }

  countOperators(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM operators").get() as Row).n as number;
  }

  countAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM operators WHERE role = 'admin'").get() as Row).n as number;
  }

  setRole(id: string, role: OperatorRole): boolean {
    return this.db.prepare("UPDATE operators SET role = ? WHERE id = ?").run(role, id).changes > 0;
  }

  setName(id: string, name: string): boolean {
    return this.db.prepare("UPDATE operators SET name = ? WHERE id = ?").run(name, id).changes > 0;
  }

  setPassword(id: string, passwordHash: string, at: string): boolean {
    return this.db.prepare("UPDATE operators SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(passwordHash, at, id).changes > 0;
  }

  /** Their sessions and invites go with them. */
  deleteOperator(id: string): boolean {
    return this.db.prepare("DELETE FROM operators WHERE id = ?").run(id).changes > 0;
  }

  /** Every operator, session and invite. */
  clear(): void {
    this.transaction(() => {
      for (const table of ["sessions", "invites", "operators"]) this.db.prepare(`DELETE FROM ${table}`).run();
    });
  }

  // Sessions

  createSession(input: NewSession): SessionRecord {
    const id = shortId("s", 8);
    this.db.prepare(`INSERT INTO sessions(id, operator_id, token_hash, created_at, last_seen_at, expires_at, client)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, input.operatorId, input.tokenHash, input.at, input.at, input.expiresAt, input.client);
    return toSession(this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row);
  }

  sessionByTokenHash(tokenHash: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    return r ? toSession(r) : null;
  }

  /** Records `at` only when the session was last seen at or before `staleSince`, so each process writes at most once per interval. */
  touchSession(id: string, at: string, staleSince: string): boolean {
    return this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at <= ?").run(at, id, staleSince).changes > 0;
  }

  /** With `operatorId`, only when the session is theirs. */
  deleteSession(id: string, operatorId?: string): boolean {
    if (operatorId === undefined) return this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
    return this.db.prepare("DELETE FROM sessions WHERE id = ? AND operator_id = ?").run(id, operatorId).changes > 0;
  }

  deleteSessionsFor(operatorId: string): number {
    return this.db.prepare("DELETE FROM sessions WHERE operator_id = ?").run(operatorId).changes;
  }

  deleteOtherSessions(operatorId: string, keepId: string): number {
    return this.db.prepare("DELETE FROM sessions WHERE operator_id = ? AND id != ?").run(operatorId, keepId).changes;
  }

  listSessionsFor(operatorId: string, live: LiveWindow): SessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE operator_id = @operatorId AND ${LIVE}
      ORDER BY last_seen_at DESC, id`).all({ ...live, operatorId }) as Row[];
    return rows.map(toSession);
  }

  listAllSessions(live: LiveWindow): SessionListing[] {
    const rows = this.db.prepare(`SELECT s.*, o.username AS username, o.name AS operator_name
      FROM sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.expires_at > @now AND s.last_seen_at > @idleSince
      ORDER BY o.username, s.last_seen_at DESC, s.id`).all(live) as Row[];
    return rows.map((r) => ({ ...toSession(r), current: false, username: r.username as string, operatorName: r.operator_name as string }));
  }

  pruneSessions(live: LiveWindow): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= @now OR last_seen_at <= @idleSince").run(live).changes;
  }

  // Invites

  createInvite(input: NewInvite): InviteRecord {
    const id = shortId("i", 8);
    this.db.prepare(`INSERT INTO invites(id, token_hash, kind, role, name, operator_id, created_by, created_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.tokenHash, input.kind, input.role, input.name, input.operatorId, input.createdBy, input.at, input.expiresAt);
    return toInvite(this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as Row);
  }

  inviteByTokenHash(tokenHash: string): InviteRecord | null {
    const r = this.db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    return r ? toInvite(r) : null;
  }

  inviteSummary(id: string): InviteSummary | null {
    const r = this.db.prepare(`SELECT i.*, o.username AS for_username, o.name AS for_name
      FROM invites i LEFT JOIN operators o ON o.id = i.operator_id WHERE i.id = ?`).get(id) as Row | undefined;
    return r ? toInviteSummary(r) : null;
  }

  /** False when someone already used it. */
  markInviteUsed(id: string, at: string): boolean {
    return this.db.prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL").run(at, id).changes > 0;
  }

  /** Unused invites that expire after `now`, newest first. */
  listPendingInvites(now: string): InviteSummary[] {
    const rows = this.db.prepare(`SELECT i.*, o.username AS for_username, o.name AS for_name
      FROM invites i LEFT JOIN operators o ON o.id = i.operator_id
      WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC, i.id`).all(now) as Row[];
    return rows.map(toInviteSummary);
  }

  /** Only an unused invite. */
  deletePendingInvite(id: string): boolean {
    return this.db.prepare("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(id).changes > 0;
  }

  deletePendingResets(operatorId: string): number {
    return this.db.prepare("DELETE FROM invites WHERE kind = 'reset' AND operator_id = ? AND used_at IS NULL").run(operatorId).changes;
  }

  /** Used invites go too once they would have expired; until then they show the link was used. */
  pruneInvites(now: string): number {
    return this.db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now).changes;
  }
}
