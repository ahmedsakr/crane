/** Pure helpers for the Your account sheet: what it says about devices, and what its forms refuse before sending. */
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH, type OperatorSession } from "@crane/contracts";
import { ago, plural, until } from "./format";

/** "1 device signed in", "3 devices signed in". */
export const devicesLabel = (n: number): string => `${plural(n, "device")} signed in`;

/** This device first, then the most recently seen. */
export function orderSessions(sessions: OperatorSession[]): OperatorSession[] {
  return [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

/** What a device is called: the browser summary the server recorded, else a plain fallback. */
export const deviceName = (s: OperatorSession): string => s.client ?? "Unknown browser";

/** The device's second line: when it was last seen and when its session runs out. */
export function deviceDetail(s: OperatorSession): string {
  const seen = s.current ? "Active now" : `Last seen ${ago(s.lastSeenAt)}`;
  return `${seen} · Expires ${until(s.expiresAt)}`;
}

export interface PasswordDraft {
  current: string;
  next: string;
  confirm: string;
}

/** Why the change-password form can't be sent yet, or null when it can. The server still checks the current one. */
export function passwordProblem({ current, next, confirm }: PasswordDraft): string | null {
  if (!current) return "Enter your current password.";
  if (next.length < MIN_PASSWORD_LENGTH) return `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (next !== confirm) return "The new passwords don't match.";
  return null;
}

/** Why a name can't be saved, or null when it can. Matches the server's rule, which trims first. */
export function nameProblem(name: string): string | null {
  const clean = name.trim();
  if (!clean) return "Enter a name.";
  if (clean.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  // The server refuses control characters, which could rewrite a terminal or log line.
  if (/\p{Cc}/u.test(clean)) return "Use letters, numbers and punctuation only.";
  return null;
}
