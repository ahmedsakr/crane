import { useState } from "react";
import type { InviteSummary } from "@crane/contracts";
import { api } from "../../lib/api";
import { until } from "../../lib/format";
import { pendingLinkLabel } from "../../lib/operators";
import { useSubmit } from "../../lib/use-submit";

export function PendingInvites({ invites, error, onChanged }: {
  invites: InviteSummary[] | null; error: string | null; onChanged: () => void;
}) {
  const { busy, error: failure, submit } = useSubmit();
  const [revoking, setRevoking] = useState<string | null>(null);
  const message = failure || error;
  return (
    <section className="section" aria-labelledby="pending-invites-title">
      <div className="section-head"><h2 className="section-title" id="pending-invites-title">Pending links</h2></div>
      {message && <p className="error-text" role="alert">{message}</p>}
      {!invites && !error && <p className="muted">Loading links…</p>}
      {invites?.length === 0 && <p className="muted">No pending invites or password resets.</p>}
      {!!invites?.length && (
        <ul className="operator-list card" aria-label="Pending invites and resets">
          {invites.map((invite) => (
            <li key={invite.id} className="operator-row">
              <div className="operator-info">
                <strong>{pendingLinkLabel(invite)}</strong>
                <small className="muted">Expires {until(invite.expiresAt)} · From {invite.invitedBy || "an admin"}</small>
              </div>
              <button type="button" className="btn btn-quiet btn-sm" disabled={busy} aria-label={`Revoke ${pendingLinkLabel(invite)}`}
                onClick={() => { setRevoking(invite.id); void submit(async () => { await api.revokeInvite(invite.id); onChanged(); }); }}>
                {busy && revoking === invite.id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
