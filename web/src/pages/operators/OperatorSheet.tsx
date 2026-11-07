import { useState } from "react";
import type { OperatorSummary } from "@crane/contracts";
import { api } from "../../lib/api";
import type { InviteLink } from "../../lib/operators";
import { useSubmit } from "../../lib/use-submit";
import { useToast } from "../../lib/toast";
import { Sheet, SheetFoot } from "../../components/Sheet";
import { LinkResult } from "./LinkResult";
import { OperatorActions, RemoveOperator, type ManagementActions } from "./OperatorActions";

export function OperatorSheet({ operator, onClose, onChanged, onIssued }: {
  operator: OperatorSummary;
  onClose: () => void;
  onChanged: (operators: OperatorSummary[]) => Promise<void>;
  onIssued: () => void;
}) {
  const [link, setLink] = useState<InviteLink | null>(null);
  const [removing, setRemoving] = useState(false);
  const { busy, error, submit } = useSubmit();
  const toast = useToast();
  const back = () => { setLink(null); setRemoving(false); };
  const view = () => {
    if (link) return "link";
    return removing ? "remove" : "operator";
  };
  const update = (action: () => Promise<OperatorSummary[]>, message: string) => void submit(async () => {
    await onChanged(await action());
    toast({ text: message });
  });
  const actions: ManagementActions = {
    role: () => update(() => api.setOperatorRole(operator.id, operator.role === "admin" ? "operator" : "admin"), "Role changed."),
    reset: () => void submit(async () => { setLink(await api.resetOperatorPassword(operator.id)); onIssued(); }),
    signOut: () => update(() => api.signOutOperator(operator.id), `${operator.name} signed out everywhere.`),
    remove: () => setRemoving(true),
  };
  const remove = () => void submit(async () => {
    await onChanged(await api.removeOperator(operator.id));
    toast({ text: `${operator.name} removed.` });
    onClose();
  });
  const content = () => {
    if (link) return <LinkResult issued={link} onDone={onClose} onBack={back} />;
    if (removing) return <RemoveOperator operator={operator} onBack={back} />;
    return <OperatorActions operator={operator} busy={busy} actions={actions} />;
  };
  return (
    <Sheet onClose={onClose} onDismiss={view() === "operator" ? onClose : back} view={view()}>
      {content()}
      {!link && <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Done</button>
        {removing && <button type="button" className="btn btn-primary" disabled={busy} onClick={remove}>
          {busy ? "Removing…" : `Remove ${operator.name}`}
        </button>}
      </SheetFoot>}
    </Sheet>
  );
}
