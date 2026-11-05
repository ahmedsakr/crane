import type { Task } from "@crane/contracts";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";
import { preApprovalText } from "./task-view";

export function PreApprovalCard({ task, main, acceptanceGate, actions }: { task: Task; main: string; acceptanceGate: string; actions: TaskActions }) {
  const { busy, run } = actions;
  return (
    <div className="card card-pad pre-approval">
      <div className="pre-approval-copy">
        <strong>{task.preApprovedAt ? "Pre-approved" : "Merge when it passes"}</strong>
        <span>{preApprovalText(!!task.preApprovedAt, main, acceptanceGate)}</span>
      </div>
      {task.preApprovedAt ? (
        <button className="btn btn-quiet btn-sm" disabled={busy}
          onClick={() => run("pre-approve", () => api.undoPreApproval(task.id), "Undid pre-approval. It waits for your review.")}>
          Undo pre-approval
        </button>
      ) : (
        <button className="btn btn-primary btn-sm" disabled={busy}
          onClick={() => run("pre-approve", () => api.preApprove(task.id), `Pre-approved. It merges into ${main} once its checks pass.`)}>
          Pre-approve
        </button>
      )}
    </div>
  );
}
