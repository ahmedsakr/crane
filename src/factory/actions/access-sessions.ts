import { normalizeUsername, type AuthStatus, type OperatorProfile, type OperatorSession } from "@crane/contracts";
import type { SessionRecord } from "@crane/storage";
import { dummyVerify, hashPassword, newToken, tokenDigest, verifyPassword } from "../auth-crypto.js";
import { AccessError } from "./access-errors.js";
import {
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_MS,
  SIGN_IN_FIRST,
  WRONG_CURRENT_PASSWORD,
  WRONG_SIGN_IN,
  checkClient,
  checkName,
  checkPassword,
  iso,
  liveWindow,
  needOperator,
  profile,
  type AccessDeps,
} from "./access-rules.js";

export type Authenticated = { operator: OperatorProfile; session: OperatorSession };
/** A new session. `token` goes to the device once and is never readable again. */
export type SignedIn = Authenticated & { token: string };

const current = (session: SessionRecord): OperatorSession => ({ ...session, current: true });

/**
 * Sign `operatorId` in on a new device. Call inside a transaction that has
 * checked the operator still exists.
 */
export function startSession(deps: AccessDeps, operatorId: string, client: unknown): SignedIn {
  const at = deps.now();
  const token = newToken();
  const session = deps.store.access.createSession({
    operatorId, tokenHash: tokenDigest(token), at: iso(at), expiresAt: iso(at + SESSION_LIFETIME_MS), client: checkClient(client),
  });
  return { token, operator: profile(needOperator(deps.store, operatorId)), session: current(session) };
}

/**
 * The operator and session a token belongs to, or null once it lasted 30
 * days, sat idle for 7, or was signed out. Records the visit at most once
 * every 5 minutes, so each request costs no write.
 */
export function authenticate(deps: AccessDeps, token: unknown): Authenticated | null {
  if (typeof token !== "string" || !token) return null;
  const { access } = deps.store;
  const session = access.sessionByTokenHash(tokenDigest(token));
  if (!session) return null;
  const at = deps.now();
  if (Date.parse(session.expiresAt) <= at || Date.parse(session.lastSeenAt) + SESSION_IDLE_MS <= at) {
    access.deleteSession(session.id);
    return null;
  }
  if (Date.parse(session.lastSeenAt) + SESSION_TOUCH_MS <= at && access.touchSession(session.id, iso(at), iso(at - SESSION_TOUCH_MS))) {
    session.lastSeenAt = iso(at);
  }
  const operator = access.operatorById(session.operatorId);
  return operator ? { operator: profile(operator), session: current(session) } : null;
}

export function authStatus(deps: AccessDeps, token: unknown, opts: { exposed: boolean }): AuthStatus {
  const operators = deps.store.access.countOperators();
  const auth = operators > 0 ? authenticate(deps, token) : null;
  return {
    required: operators > 0 || opts.exposed,
    signedIn: !!auth,
    setUp: operators > 0,
    operator: auth?.operator ?? null,
    session: auth?.session ?? null,
  };
}

/** The same answer, after the same work, whether the username or the password is wrong. */
export async function signIn(deps: AccessDeps, username: unknown, password: unknown, opts: { client?: unknown } = {}): Promise<SignedIn> {
  const operator = typeof username === "string" ? deps.store.access.operatorByUsername(normalizeUsername(username)) : null;
  if (!operator || typeof password !== "string") {
    await dummyVerify();
    throw new AccessError(401, WRONG_SIGN_IN);
  }
  if (!(await verifyPassword(password, operator.passwordHash))) throw new AccessError(401, WRONG_SIGN_IN);
  return deps.store.transaction(() => {
    // The password may have changed, or the operator gone, while scrypt ran.
    if (deps.store.access.operatorById(operator.id)?.passwordHash !== operator.passwordHash) throw new AccessError(401, WRONG_SIGN_IN);
    return startSession(deps, operator.id, opts.client);
  }, { immediate: true });
}

export function signOut(deps: AccessDeps, token: unknown): void {
  if (typeof token !== "string" || !token) return;
  const session = deps.store.access.sessionByTokenHash(tokenDigest(token));
  if (session) deps.store.access.deleteSession(session.id);
}

export function requireSession(deps: AccessDeps, token: unknown): Authenticated {
  const auth = authenticate(deps, token);
  if (!auth) throw new AccessError(401, SIGN_IN_FIRST);
  return auth;
}

export function listMySessions(deps: AccessDeps, token: unknown): OperatorSession[] {
  const { operator, session } = requireSession(deps, token);
  return deps.store.access.listSessionsFor(operator.id, liveWindow(deps.now()))
    .map((s) => ({ ...s, current: s.id === session.id }));
}

/** Only one of the caller's own devices. */
export function signOutMySession(deps: AccessDeps, token: unknown, id: string): void {
  const { operator } = requireSession(deps, token);
  if (!deps.store.access.deleteSession(id, operator.id)) throw new Error("That device isn't signed in");
}

/** Signs out every device but this one, and says how many. */
export function signOutMyOtherSessions(deps: AccessDeps, token: unknown): number {
  const { operator, session } = requireSession(deps, token);
  return deps.store.access.deleteOtherSessions(operator.id, session.id);
}

/** Keeps this device signed in and signs out the rest. */
export async function changeMyPassword(deps: AccessDeps, token: unknown, currentPassword: unknown, next: unknown): Promise<OperatorProfile> {
  const { operator, session } = requireSession(deps, token);
  const password = checkPassword(next);
  const record = needOperator(deps.store, operator.id);
  if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, record.passwordHash))) {
    throw new Error(WRONG_CURRENT_PASSWORD);
  }
  const hash = await hashPassword(password);
  return deps.store.transaction(() => {
    if (needOperator(deps.store, operator.id).passwordHash !== record.passwordHash) throw new Error("Your password just changed elsewhere; sign in again");
    if (!deps.store.access.sessionByTokenHash(tokenDigest(token as string))) throw new AccessError(401, SIGN_IN_FIRST);
    deps.store.access.setPassword(operator.id, hash, iso(deps.now()));
    deps.store.access.deleteOtherSessions(operator.id, session.id);
    return profile(needOperator(deps.store, operator.id));
  }, { immediate: true });
}

export function renameMe(deps: AccessDeps, token: unknown, name: unknown): OperatorProfile {
  const { operator } = requireSession(deps, token);
  const clean = checkName(name);
  deps.store.access.setName(operator.id, clean);
  return profile(needOperator(deps.store, operator.id));
}
