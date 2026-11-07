import { useState } from "react";
import { MAX_NAME_LENGTH, type OperatorProfile } from "@crane/contracts";
import { api } from "../../lib/api";
import { nameProblem } from "../../lib/account";
import { useSubmit } from "../../lib/use-submit";

/** Mounted only while editing, so each edit starts without the last one's error. */
function NameForm({ initial, onSaved, onCancel }: { initial: string; onSaved: (operator: OperatorProfile) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit();
  const save = () => {
    const why = nameProblem(draft);
    setProblem(why);
    if (!why) void submit(async () => onSaved(await api.renameMe(draft.trim())));
  };
  const message = problem ?? (error || null);
  return (
    <form className="account-name-form" aria-label="Edit name" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input className="input" aria-label="Name" autoComplete="name" autoFocus maxLength={MAX_NAME_LENGTH} value={draft} disabled={busy}
        aria-invalid={!!message} aria-describedby={message ? "account-name-error" : undefined}
        onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
        // Escape leaves the edit, not the sheet.
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <div className="account-name-actions">
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {message && <p id="account-name-error" className="error-text account-name-error" role="alert">{message}</p>}
    </form>
  );
}

/** The operator's name, edited in place. Saving updates the account menu at once through `onRenamed`. */
export function NameEditor({ operator, onRenamed }: { operator: OperatorProfile; onRenamed: (operator: OperatorProfile) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <NameForm initial={operator.name} onCancel={() => setEditing(false)}
      onSaved={(renamed) => { onRenamed(renamed); setEditing(false); }} />;
  }
  return (
    <div className="account-name-row">
      <strong className="account-display-name">{operator.name || operator.username}</strong>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit name</button>
    </div>
  );
}
