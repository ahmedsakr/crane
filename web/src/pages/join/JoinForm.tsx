import { useState, type FormEvent } from "react";
import { normalizeUsername, type InviteCheck } from "@crane/contracts";
import { joinProblem, linkFailure, type JoinDraft } from "../../lib/join";
import { JoinIdentity, JoinPasswords } from "./JoinFields";

export type JoinInput = { username?: string; name?: string; password: string };

export function JoinForm({ invite, onAccept, onInvalid }: {
  invite: InviteCheck; onAccept: (input: JoinInput) => Promise<void>; onInvalid: () => void;
}) {
  const [draft, setDraft] = useState<JoinDraft>({ name: invite.name ?? "", username: invite.username ?? "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (key: keyof JoinDraft, value: string) => { setDraft((d) => ({ ...d, [key]: value })); setError(null); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = joinProblem(invite.kind, draft);
    setError(problem);
    if (problem || busy) return;
    setBusy(true);
    try {
      const input: JoinInput = { password: draft.password };
      if (invite.kind === "join") Object.assign(input, { name: draft.name.trim(), username: normalizeUsername(draft.username) });
      await onAccept(input);
    } catch (err) {
      const failure = linkFailure(err);
      if (failure.invalid) onInvalid();
      else setError(failure.message);
      setDraft((d) => ({ ...d, password: "", confirm: "" }));
      setBusy(false);
    }
  };
  const reset = invite.kind === "reset";
  const action = reset ? "Set password" : "Join";
  return (
    <form className="sign-in-form" onSubmit={submit} aria-describedby={error ? "join-error" : undefined}>
      {reset ? <input type="text" name="username" autoComplete="username" value={draft.username} readOnly hidden />
        : <JoinIdentity draft={draft} busy={busy} change={change} />}
      <JoinPasswords draft={draft} busy={busy} change={change} />
      {error && <p id="join-error" className="sign-in-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-lg sign-in-submit" type="submit" disabled={busy}>
        {busy ? "Signing in…" : action}
      </button>
    </form>
  );
}
