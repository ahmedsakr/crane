import { useRef, useState, type FormEvent } from "react";
import type { AuthStatus } from "@crane/contracts";
import { api } from "../lib/api";
import { signInFailure } from "../lib/auth";
import { Mark } from "../components/Mark";

function SignInForm({ onSignedIn }: { onSignedIn: (status: AuthStatus) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.signIn(username, password));
    } catch (err) {
      setError(signInFailure(err));
      setPassword("");
      setBusy(false);
      passwordInput.current?.focus();
    }
  };
  return (
    <form className="sign-in-form" onSubmit={submit} aria-describedby={error ? "sign-in-error" : undefined}>
      <label className="sign-in-field">
        <span>Username</span>
        <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required
          autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="sign-in-field">
        <span>Password</span>
        <input ref={passwordInput} className="input" name="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && (
        <p id="sign-in-error" className="sign-in-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary btn-lg sign-in-submit" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/** What a factory that needs sign-in shows instead of the dashboard. The URL stays put, so signing in lands there. */
export function SignIn({ status, onSignedIn }: { status: AuthStatus; onSignedIn: (status: AuthStatus) => void }) {
  return (
    <main className="sign-in">
      <div className="sign-in-card">
        <Mark size={44} />
        <h1 className="sign-in-title">Sign in to Crane</h1>
        {status.setUp ? (
          <>
            <SignInForm onSignedIn={onSignedIn} />
            <p className="sign-in-note muted">New here? Ask an admin for an invite link.</p>
          </>
        ) : (
          <p className="sign-in-setup">
            Sign-in isn't set up. On the host, run <code className="mono">crane operators add &lt;username&gt; --admin</code>.
          </p>
        )}
      </div>
    </main>
  );
}
