import type { OperatorSummary } from "@crane/contracts";
import { devicesLabel } from "../../lib/account";
import { ROLE_LABEL } from "../../lib/auth";
import { operatorSeen } from "../../lib/operators";
import { Chevron } from "../../components/Chevron";

function OperatorInfo({ operator }: { operator: OperatorSummary }) {
  return (
    <>
      <span className="operator-info">
        <strong>{operator.name}</strong>
        <span className="muted mono">{operator.username}</span>
        <small className="muted">{operatorSeen(operator)} · {devicesLabel(operator.devices)}</small>
      </span>
      <span className="chip">{ROLE_LABEL[operator.role]}</span>
    </>
  );
}

export function OperatorList({ operators, admin, onChoose }: {
  operators: OperatorSummary[]; admin: boolean; onChoose: (operator: OperatorSummary) => void;
}) {
  return (
    <ul className="operator-list card" aria-label="Operators">
      {operators.map((operator) => (
        <li key={operator.id}>
          {admin ? (
            <button type="button" className="operator-row" data-operator={operator.username} onClick={() => onChoose(operator)}>
              <OperatorInfo operator={operator} /><Chevron />
            </button>
          ) : <div className="operator-row"><OperatorInfo operator={operator} /></div>}
        </li>
      ))}
    </ul>
  );
}
