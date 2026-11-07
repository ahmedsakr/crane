import { useId, useState } from "react";
import { MAX_NAME_LENGTH, type OperatorRole } from "@crane/contracts";
import { api } from "../../lib/api";
import type { InviteLink } from "../../lib/operators";
import { useSubmit } from "../../lib/use-submit";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";
import { LinkResult } from "./LinkResult";

export function InviteSheet({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const [issued, setIssued] = useState<InviteLink | null>(null);
  return (
    <Sheet onClose={onClose} view={issued ? "link" : "invite"}>
      {issued ? <LinkResult issued={issued} onDone={onClose} /> : <InviteForm onIssued={(link) => { setIssued(link); onIssued(); }} />}
    </Sheet>
  );
}

export function InviteForm({ onIssued }: { onIssued: (link: InviteLink) => void }) {
  const form = useId();
  const [role, setRole] = useState<OperatorRole>("operator");
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <>
      <SheetHead title="Invite operator" subtitle="A single-use link to join this factory." />
      <SheetBody>
        <form id={form} className="account-fields" onSubmit={(e) => {
          e.preventDefault();
          void submit(async () => onIssued(await api.inviteOperator(role, name.trim() || undefined)));
        }}>
          <label className="account-field">
            <span>Role</span>
            <select className="input" name="role" value={role} disabled={busy} onChange={(e) => setRole(e.target.value as OperatorRole)}>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <p className="muted account-hint">Operators can run factory work. Admins can also manage who has access.</p>
          <label className="account-field">
            <span>Name <span className="muted">(optional)</span></span>
            <input className="input" name="name" autoComplete="off" maxLength={MAX_NAME_LENGTH} value={name}
              disabled={busy} onChange={(e) => setName(e.target.value)} />
          </label>
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button className="btn btn-primary" form={form} disabled={busy}>{busy ? "Creating…" : "Create invite"}</button>
      </SheetFoot>
    </>
  );
}
