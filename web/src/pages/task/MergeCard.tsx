import { visualReviewPending, type Repo, type Task } from "@crane/contracts";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";

/** An approved branch not yet landed: merge it here, or by hand. */
export function MergeCard({ task, repo, main, actions }: { task: Task; repo: Repo | null; main: string; actions: TaskActions }) {
  if ((task.status !== "approved" && task.status !== "done") || !task.branch || !repo) return null;
  const { busy, run } = actions;
  return (
    <div className="card card-pad">
      <h3 className="card-title">Merge into {main}</h3>
      <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--ink-2)" }}>
        Crane merges {task.branch} and pushes it. An agent resolves any conflicts.
      </p>
      <button className="btn btn-primary btn-sm" disabled={busy || visualReviewPending(task)} onClick={() => run("merge", () => api.merge(task.id), "Merging it now")}>
        Merge
      </button>
      <details style={{ marginTop: 12 }}>
        <summary className="muted" style={{ fontSize: 13, cursor: "pointer" }}>
          Or merge it yourself
        </summary>
        <p className="mono" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>
          git -C {repo.path} merge {task.branch}
        </p>
      </details>
    </div>
  );
}
