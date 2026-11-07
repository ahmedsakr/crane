import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN, normalizeUsername, type InviteCheck } from "@crane/contracts";
import { nameProblem } from "./account";
import { signInFailure } from "./auth";

export const INVALID_LINK = "This link has expired or was already used. Ask an admin for a new one.";
export const USERNAME_HINT = "3–32 lowercase letters, numbers, dots, underscores or hyphens. Start with a letter or number.";
// HTML patterns use the v flag, which requires escaping even a terminal literal hyphen in a class.
export const USERNAME_INPUT_PATTERN = USERNAME_PATTERN.source.replace(/-\]/g, "\\-]");

/** Read once on entry, then clear the fragment before any request. Never persist the token in browser storage. */
export function takeInviteToken(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "state" | "replaceState">): string {
  const token = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  return token;
}

/** StrictMode replays effects. Share the first check rather than spending two rate-limit attempts. */
export function inviteChecker(token: string, check: (token: string) => Promise<InviteCheck>) {
  let pending: Promise<InviteCheck> | null = null;
  return (retry = false): Promise<InviteCheck> => {
    if (!pending || retry) pending = check(token);
    return pending;
  };
}

export function linkFailure(error: unknown): { invalid: boolean; message: string } {
  if ((error as { status?: number } | null)?.status === 401) return { invalid: true, message: INVALID_LINK };
  return { invalid: false, message: signInFailure(error) };
}

export interface JoinDraft {
  name: string;
  username: string;
  password: string;
  confirm: string;
}

export function joinProblem(kind: InviteCheck["kind"], draft: JoinDraft): string | null {
  if (kind === "join") {
    const why = nameProblem(draft.name);
    if (why) return why;
    if (!USERNAME_PATTERN.test(normalizeUsername(draft.username))) return USERNAME_HINT;
  }
  if (draft.password.length < MIN_PASSWORD_LENGTH) return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (draft.password !== draft.confirm) return "The passwords don't match.";
  return null;
}
