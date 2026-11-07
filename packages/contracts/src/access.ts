/** Operators, their sessions and invites, and who did something. */
import type { TaskEvent } from "./events.js";

export type OperatorRole = "admin" | "operator";

export interface OperatorProfile {
  id: string;
  username: string;
  name: string;
  role: OperatorRole;
  createdAt: string;
  /** When any of their devices last made a request, or null when none is signed in. */
  lastSeenAt: string | null;
}

export type OperatorSummary = OperatorProfile & {
  /** Devices signed in now. */
  devices: number;
};

export interface OperatorSession {
  id: string;
  operatorId: string;
  /** The device asking. */
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** A short summary of the browser, like "Firefox on macOS". */
  client: string | null;
}

export interface InviteSummary {
  id: string;
  /** A join link adds an operator; a reset link sets an existing operator's password. */
  kind: "join" | "reset";
  /** The role a join link gives, or null for a reset link. */
  role: OperatorRole | null;
  /** The suggested name for a join link. */
  name: string | null;
  /** Whose password a reset link sets. */
  forOperator: { id: string; username: string; name: string } | null;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** What someone opening a link sees before accepting it. */
export interface InviteCheck {
  kind: InviteSummary["kind"];
  role: OperatorRole | null;
  name: string | null;
  /** The username a reset link is for. */
  username: string | null;
  invitedBy: string | null;
  expiresAt: string;
}

export interface AuthStatus {
  /** Whether API calls need a session. */
  required: boolean;
  signedIn: boolean;
  /** Whether any operator exists yet. */
  setUp: boolean;
  operator: OperatorProfile | null;
  session: OperatorSession | null;
}

/** Who did something: a signed-in operator, or someone running crane on the host. */
export type EventActor = { kind: "operator"; id: string; name: string } | { kind: "host"; name: string };

export const MIN_PASSWORD_LENGTH = 12;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MAX_NAME_LENGTH = 60;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The path a join or reset link opens. The token rides in the fragment, which browsers never send to a server, so
 * no proxy or access log sees it.
 */
export function inviteLinkPath(token: string): string {
  return `/join#${token}`;
}

export function actorLabel(actor: EventActor): string {
  return actor.kind === "operator" ? actor.name : `${actor.name} on the host`;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Whether stored JSON is a usable actor snapshot, so a malformed record shows no name rather than a broken one. */
export function isEventActor(v: unknown): v is EventActor {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (!nonEmpty(a.name)) return false;
  return a.kind === "host" || (a.kind === "operator" && nonEmpty(a.id));
}

/** Who made an event, from the snapshot Crane stored with it; null when unattributed or malformed. */
export function eventActor(e: Pick<TaskEvent, "data">): EventActor | null {
  const actor = e.data?.actor;
  return isEventActor(actor) ? actor : null;
}

// Order matters: Edge and Opera also claim Chrome, Chrome claims Safari, and iPads claim macOS.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(OPR|Opera)\//, "Opera"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
  [/^curl\//, "curl"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\b(iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

const firstMatch = (table: [RegExp, string][], text: string) => table.find(([pattern]) => pattern.test(text))?.[1] ?? null;

/** A short summary of a User-Agent, like "Firefox on macOS", or null when it says nothing recognizable. */
export function describeClient(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string" || !userAgent.trim()) return null;
  const browser = firstMatch(BROWSERS, userAgent);
  const system = firstMatch(SYSTEMS, userAgent);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}
