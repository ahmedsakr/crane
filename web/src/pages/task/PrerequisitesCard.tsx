import { Link } from "react-router-dom";
import type { PrerequisiteState } from "@crane/contracts";
import { StatusChip } from "../../components/Status";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";
import { prerequisitesText } from "./task-view";

export function PrerequisitesCard({ taskId, waitingOn, main, actions }: { taskId: string; waitingOn: PrerequisiteState[]; main: string; actions: TaskActions }) {
  if (waitingOn.length === 0) return null;
  const { busy, run } = actions;
  return (
    <div className="card card-pad pre-approval">
      <div className="pre-approval-copy">
        <strong>Waiting for prerequisites</strong>
        <span>{prerequisitesText(waitingOn.length, main)}</span>
        <ul className="gate-list">
          {waitingOn.map((p) => (
            <li key={p.id}>
              <Link className="mono" to={`/tasks/${p.id}`}>{p.id}</Link>
              <span>{p.title}</span>
              <StatusChip status={p.status} />
            </li>
          ))}
        </ul>
      </div>
      <button className="btn btn-quiet btn-sm" disabled={busy}
        onClick={() => run("waive", () => api.waivePrerequisites(taskId), "Waived prerequisites. Its start time still applies.")}>
        Waive prerequisites
      </button>
    </div>
  );
}
