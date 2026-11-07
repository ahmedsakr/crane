import { useId, useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@crane/contracts";
import { api } from "../../lib/api";
import { passwordProblem, type PasswordDraft } from "../../lib/account";
import { useSubmit } from "../../lib/use-submit";
import { SheetBody, SheetFoot, SheetHead } from "../Sheet";

const FIELDS: { key: keyof PasswordDraft; label: string; autoComplete: string }[] = [
  { key: "current", label: "Current password", autoComplete: "current-password" },
  { key: "next", label: "New password", autoComplete: "new-password" },
  { key: "confirm", label: "Confirm new password", autoComplete: "new-password" },
];

/** Replaces the account sheet's contents. A new password keeps this device signed in and signs out the others. */
export function PasswordForm({ username, onBack, onChanged }: { username: string; onBack: () => void; onChanged: () => void }) {
  const form = useId();
  const [draft, setDraft] = useState<PasswordDraft>({ current: "", next: "", confirm: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();
  const save = () => {
    const why = passwordProblem(draft);
    setProblem(why);
    if (!why) void submit(async () => { await api.changeMyPassword(draft.current, draft.next); onChanged(); });
  };
  const message = problem ?? (error || null);
  return (
    <>
      <SheetHead onBack={onBack} title="Change password" subtitle="Your other devices will be signed out." />
      <SheetBody>
        <form id={form} className="account-fields" aria-label="Change password" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {/* Lets password managers file the new password under the right account. */}
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          {FIELDS.map((f) => (
            <label key={f.key} className="account-field">
              <span>{f.label}</span>
              <input className="input" type="password" name={f.key} autoComplete={f.autoComplete} disabled={busy} value={draft[f.key]}
                onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); setProblem(null); }} />
            </label>
          ))}
          <p className="muted account-hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
        </form>
      </SheetBody>
      <SheetFoot note={message ? <span role="alert" className="error-text">{message}</span> : undefined}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onBack}>Cancel</button>
        <button className="btn btn-primary" form={form} disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
      </SheetFoot>
    </>
  );
}
