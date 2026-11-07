/**
 * Who is signed in, and the signal that says they no longer are. Nothing here imports the API client, so
 * `req()` can raise the signal without a cycle; `use-auth.ts` binds the store to the real calls.
 */
import type { AuthStatus, OperatorProfile, OperatorRole } from "@crane/contracts";

/** Thrown for a call refused for want of a session. The app returns to sign-in, so callers needn't say so. */
export class SignedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedOutError";
  }
}

export const isSignedOut = (e: unknown): boolean => e instanceof SignedOutError;

/** A refusal the gate makes for want of a session, rather than a wrong password or a missing permission. */
export function isSignInRefusal(status: number, body: unknown): boolean {
  return status === 401 && !!body && typeof body === "object" && (body as { signIn?: unknown }).signIn === true;
}

const refusalListeners = new Set<() => void>();

/** Called by `req()` on every refusal; listeners decide what to do once. */
export function notifySignInRequired(): void {
  for (const listener of [...refusalListeners]) listener();
}

export function onSignInRequired(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

/** Whether the app shows sign-in instead of the dashboard. */
export const needsSignIn = (status: AuthStatus): boolean => status.required && !status.signedIn;

/** The same factory, with this device's session gone. */
export const withoutSession = (status: AuthStatus): AuthStatus => ({ ...status, required: true, signedIn: false, operator: null, session: null });

export const ROLE_LABEL: Record<OperatorRole, string> = { admin: "Admin", operator: "Operator" };

/** What a rate-limited sign-in says, rounded up so it never invites an early retry. */
export function retryAfterText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `Too many attempts. Try again in ${s === 1 ? "1 second" : `${s} seconds`}.`;
  const minutes = Math.ceil(s / 60);
  return `Too many attempts. Try again in ${minutes === 1 ? "1 minute" : `${minutes} minutes`}.`;
}

/** The inline line for a failed sign-in: the wait when limited, otherwise what the server said. */
export function signInFailure(e: unknown): string {
  const body = (e as { body?: { retryAfterSeconds?: unknown } } | null)?.body;
  const wait = body?.retryAfterSeconds;
  if (typeof wait === "number" && Number.isFinite(wait)) return retryAfterText(wait);
  return e instanceof Error && e.message ? e.message : "Sign-in didn't work. Try again.";
}

/** One letter for the account button: the first of the name, else of the username. */
export function initialOf(name: string, username: string): string {
  const first = [...(name.trim() || username.trim())][0];
  return first ? first.toUpperCase() : "?";
}

export interface AuthCalls {
  session: () => Promise<AuthStatus>;
  signOut: () => Promise<AuthStatus>;
}

export interface AuthSnapshot {
  status: AuthStatus | null;
  /** Why the last session check failed, when there's no status yet to fall back on. */
  error: string | null;
}

/**
 * The session as the app knows it. A refusal marks it signed out at once, so every page that's polling stops on the
 * next render rather than each failing in turn, then asks the server for the full picture once.
 */
export function createAuthStore(calls: AuthCalls) {
  let snapshot: AuthSnapshot = { status: null, error: null };
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: AuthSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const set = (status: AuthStatus) => publish({ status, error: null });
  const refresh = (): Promise<void> => {
    loading ??= calls
      .session()
      .then(set, (e: unknown) => publish({ ...snapshot, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => (loading = null));
    return loading;
  };
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set,
    refresh,
    /** The operator changed their own profile, such as their name; everything showing it updates without a reload. */
    setOperator(operator: OperatorProfile) {
      const { status } = snapshot;
      if (status?.operator?.id === operator.id) set({ ...status, operator });
    },
    /** A call was refused for want of a session. */
    refused() {
      const { status } = snapshot;
      if (status && needsSignIn(status)) return;
      if (status) set(withoutSession(status));
      void refresh();
    },
    async signOut() {
      set(await calls.signOut());
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
