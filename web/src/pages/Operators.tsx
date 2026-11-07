import { useState } from "react";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useAuth } from "../lib/use-auth";
import { InviteSheet } from "./operators/InviteSheet";
import { OperatorList } from "./operators/OperatorList";
import { OperatorSheet } from "./operators/OperatorSheet";
import { PendingInvites } from "./operators/PendingInvites";

const noInvites = async () => [];

export function Operators() {
  const { operator, refresh: refreshAuth } = useAuth();
  const admin = operator?.role === "admin";
  const operators = usePoll(api.operators, 15_000);
  // Pending links are admin-only on the API, too. Never request them as an operator.
  const invites = usePoll(admin ? api.invites : noInvites, 15_000, [admin]);
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = operators.data?.find((o) => o.id === selected);
  const refresh = () => { operators.refresh(); invites.refresh(); };
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Operators</h1>
        {admin && <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}>Invite operator</button>}
      </div>
      <p className="muted operator-intro">The people who can sign in and run this factory.</p>
      <p className="muted operator-host">To add the first admin or turn sign-in off, use crane on the host.</p>
      {operators.error && <p className="error-text" role="alert">{operators.error} <button className="btn btn-quiet btn-sm" onClick={refresh}>Try again</button></p>}
      {!operators.data && !operators.error && <p className="muted">Loading operators…</p>}
      {operators.data && <OperatorList operators={operators.data} admin={admin} onChoose={(o) => setSelected(o.id)} />}
      {admin && <PendingInvites invites={invites.data} error={invites.error} onChanged={invites.refresh} />}
      {admin && inviting && <InviteSheet onClose={() => setInviting(false)} onIssued={invites.refresh} />}
      {admin && chosen && <OperatorSheet operator={chosen} onClose={() => setSelected(null)} onIssued={invites.refresh}
        onChanged={async () => { await refreshAuth(); await operators.refresh(); invites.refresh(); }} />}
    </>
  );
}
