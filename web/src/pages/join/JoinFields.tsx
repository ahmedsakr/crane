import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from "@crane/contracts";
import { USERNAME_HINT, USERNAME_INPUT_PATTERN, type JoinDraft } from "../../lib/join";

export type DraftFields = { draft: JoinDraft; busy: boolean; change: (key: keyof JoinDraft, value: string) => void };

export function JoinIdentity({ draft, busy, change }: DraftFields) {
  return (
    <>
      <label className="sign-in-field">
        <span>Name</span>
        <input className="input" name="name" autoComplete="name" required maxLength={MAX_NAME_LENGTH} value={draft.name}
          disabled={busy} onChange={(e) => change("name", e.target.value)} />
      </label>
      <label className="sign-in-field">
        <span>Username</span>
        <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
          required pattern={USERNAME_INPUT_PATTERN} minLength={3} maxLength={32} value={draft.username} aria-describedby="join-username-hint"
          disabled={busy} onChange={(e) => change("username", e.target.value)} />
        <small className="join-hint" id="join-username-hint">{USERNAME_HINT}</small>
      </label>
    </>
  );
}

export function JoinPasswords({ draft, busy, change }: DraftFields) {
  return (
    <>
      <label className="sign-in-field">
        <span>Password</span>
        <input className="input" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH}
          value={draft.password} disabled={busy} onChange={(e) => change("password", e.target.value)} aria-describedby="join-password-hint" />
        <small className="join-hint" id="join-password-hint">At least {MIN_PASSWORD_LENGTH} characters.</small>
      </label>
      <label className="sign-in-field">
        <span>Confirm password</span>
        <input className="input" name="confirm" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH}
          value={draft.confirm} disabled={busy} onChange={(e) => change("confirm", e.target.value)} />
      </label>
    </>
  );
}
