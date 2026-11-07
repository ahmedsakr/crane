import { useState } from "react";
import { absoluteInviteLink, type InviteLink } from "../../lib/operators";
import { SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

/** Kept only in the issuing sheet; closing or going back discards the secret. */
export function LinkResult({ issued, onDone, onBack }: { issued: InviteLink; onDone: () => void; onBack?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const link = absoluteInviteLink(window.location.origin, issued.path);
  const reset = issued.invite.kind === "reset";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setError("");
    } catch {
      setError("Couldn't copy. Select the link and copy it.");
    }
  };
  return (
    <>
      <SheetHead title={reset ? "Password reset link" : "Invite link"} onBack={onBack} />
      <SheetBody>
        <div className="account-fields">
          <p className="muted">Copy this link now. It won't be shown again.</p>
          <label className="account-field">
            <span>{reset ? "Reset link" : "Invite link"}</span>
            <textarea className="input operator-link" readOnly value={link} rows={4} onFocus={(e) => e.target.select()} />
          </label>
          <p className="account-hint muted">
            {reset ? "Expires in 24 hours. Anyone with this link can change the password, so send it privately."
              : "Expires in 7 days. Anyone with this link can join, so send it privately."}
          </p>
        </div>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Done</button>
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </SheetFoot>
    </>
  );
}
