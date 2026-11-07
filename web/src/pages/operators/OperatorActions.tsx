import type { OperatorSummary } from "@crane/contracts";
import { ROLE_LABEL } from "../../lib/auth";
import { devicesLabel } from "../../lib/account";
import { operatorSeen } from "../../lib/operators";
import { SheetBody, SheetHead } from "../../components/Sheet";

export interface ManagementActions {
  role: () => void;
  reset: () => void;
  signOut: () => void;
  remove: () => void;
}

export function OperatorActions({ operator, busy, actions }: { operator: OperatorSummary; busy: boolean; actions: ManagementActions }) {
  return (
    <>
      <SheetHead title={operator.name} subtitle={operator.username} />
      <SheetBody>
        <div className="account-who">
          <p className="account-role">{ROLE_LABEL[operator.role]} · {devicesLabel(operator.devices)}</p>
          <p className="muted account-hint">{operatorSeen(operator)}</p>
        </div>
        <div className="account-links operator-actions">
          <button type="button" className="sheet-link" disabled={busy} onClick={actions.role}>
            {operator.role === "admin" ? "Make operator" : "Make admin"}
          </button>
          <button type="button" className="sheet-link" disabled={busy} onClick={actions.reset}>Reset password</button>
          <button type="button" className="sheet-link" disabled={busy} onClick={actions.signOut}>Sign out everywhere</button>
          <button type="button" className="sheet-link error-text" disabled={busy} onClick={actions.remove}>Remove</button>
        </div>
      </SheetBody>
    </>
  );
}

export function RemoveOperator({ operator, onBack }: {
  operator: OperatorSummary; onBack: () => void;
}) {
  return (
    <>
      <SheetHead title={`Remove ${operator.name}?`} subtitle={operator.username} onBack={onBack} />
      <SheetBody>
        <p>Remove {operator.name} (<span className="mono">{operator.username}</span>) from this factory?</p>
        <p className="muted">Their devices will be signed out and their reset links revoked. Their past work stays attributed to them.</p>
      </SheetBody>
    </>
  );
}
