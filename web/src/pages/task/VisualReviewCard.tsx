import { useState } from "react";
import { visualReviewPending, visualReviewWaivedByPreApproval, type Task } from "@crane/contracts";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";
import { visualReviewHeading, visualReviewText } from "./task-view";

function VisualReviewForm({ task, busy, save }: { task: Task; busy: boolean; save: (input: { status: "inspected" | "waived"; commit: string; note: string }) => void }) {
  const [status, setStatus] = useState<"inspected" | "waived">("inspected");
  const [commit, setCommit] = useState(task.visualReview?.commit ?? "");
  const [note, setNote] = useState("");
  return <details>
    <summary>Record inspection or waiver</summary>
    <form className="visual-review-fields" onSubmit={e => { e.preventDefault(); save({ status, commit, note }); }}>
      <label>Decision
        <select className="input" value={status} onChange={e => setStatus(e.target.value as typeof status)} disabled={busy}>
          <option value="inspected">I inspected this candidate</option>
          <option value="waived">I waive visual review for this candidate</option>
        </select>
      </label>
      <label>Candidate commit
        <input className="input mono" required value={commit} onChange={e => setCommit(e.target.value)} pattern="[a-f0-9]{40,64}" readOnly={!!task.visualReview} disabled={busy} />
      </label>
      <label>{status === "inspected" ? "Reviewed views, sizes and screenshot paths" : "Waiver reason and unreviewed scope"}
        <textarea className="input" required maxLength={10000} value={note} onChange={e => setNote(e.target.value)} disabled={busy} />
      </label>
      <button className="btn btn-primary" disabled={busy || !note.trim()}>{status === "inspected" ? "Record inspection" : "Record waiver"}</button>
    </form>
  </details>;
}

export function VisualReviewCard({ task, actions }: { task: Task; actions: TaskActions }) {
  if (!task.branch || !["needs_review", "approved", "done"].includes(task.status)) return null;
  const { busy, run } = actions;
  const pending = visualReviewPending(task);
  const decided = !pending && !visualReviewWaivedByPreApproval(task);
  return <div className="card card-pad visual-review">
    <h2 className="card-title">Visual review: {visualReviewHeading(task)}</h2>
    <p>{visualReviewText(task)}</p>
    {decided && task.visualReview && <details>
      <summary>Candidate decision</summary>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>{task.visualReview.commit}</p>
      {task.visualReview.decidedAt && <p>Recorded {new Date(task.visualReview.decidedAt).toLocaleString()}</p>}
    </details>}
    {pending && <>
      <p>{task.visualReview?.note}</p>
      <p>Inspect the candidate at wide (1280 × 800), short (1280 × 600), and phone (390 × 844) sizes using the report's handoff below.</p>
      <VisualReviewForm key={`${task.id}:${task.visualReview?.commit}`} task={task} busy={busy}
        save={input => run("visual-review", () => api.recordVisualReview(task.id, input), "Visual decision recorded. You can approve or merge the candidate.")} />
    </>}
  </div>;
}
