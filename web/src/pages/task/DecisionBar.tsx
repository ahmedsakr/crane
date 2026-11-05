import { visualReviewPending, type Task } from "@crane/contracts";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";
import { decisionHeading, decisionText } from "./task-view";

/** What a task waiting on review asks of the operator, and the buttons that answer it. */
export function DecisionBar({ task, main, mergeError, unmet, actions }: {
  task: Task;
  main: string;
  mergeError: string | undefined;
  unmet: number;
  actions: TaskActions;
}) {
  if (task.status !== "needs_review") return null;
  const { busy, run } = actions;
  const { branch } = task;
  const visualPending = visualReviewPending(task);
  return (
    <div className="decision">
      <div className="decision-copy">
        <strong>{decisionHeading(branch, mergeError, main)}</strong>
        <span>{decisionText({ branch, mergeError, main, unmet })}</span>
      </div>
      <div className="decision-actions">
        <button className="btn btn-quiet" disabled={busy} onClick={() => run("reject", () => api.reject(task.id), "Declined")}>
          Decline
        </button>
        {branch && (
          <button
            className="btn btn-quiet"
            disabled={busy || visualPending}
            onClick={() => run("approve-only", () => api.approve(task.id, { merge: false }), "Approved. The branch is kept for you.")}
          >
            Approve only
          </button>
        )}
        <button
          className="btn btn-crane"
          disabled={busy || visualPending}
          onClick={() => run("approve", () => api.approve(task.id), branch ? "Approved. Merging it now." : "Marked as reviewed")}
        >
          {branch ? "Approve and merge" : "Mark as reviewed"}
        </button>
      </div>
    </div>
  );
}
