import { useState } from "react";
import { SheetBody, SheetFoot, SheetHead } from "../Sheet";

export function RunnerToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const url = window.location.origin.replaceAll("'", "'\\''");
  const command = `printf '%s\\n' '${token}' | crane runner start --url '${url}' --token-stdin`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setError("");
    } catch {
      setError("Couldn't copy. Select the command and copy it.");
    }
  };
  return <>
    <SheetHead title="Start your container" subtitle={name} />
    <SheetBody>
      <div className="account-fields">
        <p className="muted">Run this command on the computer where you sign in to Claude Code or Codex. Crane shows the token once.</p>
        <label className="account-field">
          <span>Start command with token</span>
          <textarea className="input operator-link" readOnly rows={4} value={command} onFocus={(e) => e.target.select()} />
        </label>
        <a href="https://github.com/ahmedsakr/crane#containers" target="_blank" rel="noreferrer">Read the container docs</a>
      </div>
    </SheetBody>
    <SheetFoot note={error && <span className="error-text" role="alert">{error}</span>}>
      <button type="button" className="btn btn-quiet" onClick={onDone}>Done</button>
      <button type="button" className="btn btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy command"}</button>
    </SheetFoot>
  </>;
}
