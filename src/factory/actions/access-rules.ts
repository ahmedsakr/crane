import {
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  USERNAME_PATTERN,
  normalizeUsername,
  type EventActor,
  type OperatorProfile,
  type OperatorRole,
} from "@crane/contracts";
import type { Store } from "../../core/store.js";
import type { LiveWindow, OperatorRecord } from "../../core/store/access.js";
import { AccessError } from "./access-errors.js";

/** What access actions need: the store and a clock, which tests replace to move through expiry. */
export type AccessDeps = { store: Store; now: () => number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const SESSION_LIFETIME_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
/** A session's last_seen_at is written at most this often. */
export const SESSION_TOUCH_MS = 5 * MINUTE;
export const JOIN_LINK_MS = 7 * DAY;
export const RESET_LINK_MS = DAY;

const MAX_PASSWORD_LENGTH = 1024;
const MAX_CLIENT_LENGTH = 100;

export const WRONG_SIGN_IN = "That username or password isn't right";
export const EXPIRED_LINK = "This link has expired or was already used";
export const SIGN_IN_FIRST = "Sign in to continue";
export const WRONG_CURRENT_PASSWORD = "Your current password isn't right";
export const LAST_ADMIN = "Keep at least one admin";

export const iso = (ms: number) => new Date(ms).toISOString();

/** Sessions still signed in at `at`. */
export function liveWindow(at: number): LiveWindow {
  return { now: iso(at), idleSince: iso(at - SESSION_IDLE_MS) };
}

export function checkUsername(raw: unknown): string {
  const username = typeof raw === "string" ? normalizeUsername(raw) : "";
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("Choose a username of 3 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit");
  }
  return username;
}

export function checkName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  // Control characters would let a name rewrite the terminal or a log line.
  if (!name || name.length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new Error(`Enter a name of 1 to ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

export function checkPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (raw.length > MAX_PASSWORD_LENGTH) throw new Error(`Choose a password of at most ${MAX_PASSWORD_LENGTH} characters`);
  return raw;
}

export function checkRole(raw: unknown): OperatorRole {
  if (raw !== "admin" && raw !== "operator") throw new Error("Choose the role admin or operator");
  return raw;
}

/** A short device summary such as describeClient gives; anything else is cut down to size. */
export function checkClient(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const client = raw.replace(/\p{Cc}/gu, "").trim().slice(0, MAX_CLIENT_LENGTH);
  return client || null;
}

/** The host counts as an admin. An operator must still exist and be one. */
export function requireAdmin(store: Store, by: EventActor): void {
  if (by.kind === "host") return;
  if (by.kind !== "operator" || store.access.operatorById(by.id)?.role !== "admin") {
    throw new AccessError(403, "Only admins can manage operators");
  }
}

/** Things a remote browser must never do, such as setting a password without a link. */
export function requireHost(by: EventActor): void {
  if (by.kind !== "host") throw new AccessError(403, "Do this on the host with crane");
}

export function refuseTakenUsername(store: Store, username: string): void {
  if (store.access.operatorByUsername(username)) throw new Error("That username is taken");
}

export function needOperator(store: Store, id: string): OperatorRecord {
  const operator = typeof id === "string" ? store.access.operatorById(id) : null;
  if (!operator) throw new Error(`No operator ${String(id)}`);
  return operator;
}

/** What may leave the factory about an operator: never the password hash. */
export function profile(operator: OperatorRecord): OperatorProfile {
  const { id, username, name, role, createdAt, lastSeenAt } = operator;
  return { id, username, name, role, createdAt, lastSeenAt };
}

/** Run `fn` atomically after checking, inside the same transaction, that `by` may manage operators. */
export function asAdmin<T>(store: Store, by: EventActor, fn: () => T): T {
  return store.transaction(() => {
    requireAdmin(store, by);
    return fn();
  }, { immediate: true });
}
