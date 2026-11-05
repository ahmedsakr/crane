import { useId, useState } from "react";
import type { Goal } from "@crane/contracts";
import { api } from "../../lib/api";
import { DECISION_LABEL, type GoalDecisionMode } from "../../lib/goal-plan";
import { useSubmit } from "../../lib/use-submit";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

function FeedbackFields({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <>
      <label className="tuning-field">
        What should change?
        <textarea className="input" rows={6} required maxLength={20000} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Adjust the scope, split a task, choose another agent, or ask for more evidence…" />
      </label>
      <p className="muted">The research agent will review your feedback and return a full revised plan for approval.</p>
    </>
  );
}

function ApproveFields({ taskCount, autoMerge, onChange }: { taskCount?: number; autoMerge: boolean; onChange: (autoMerge: boolean) => void }) {
  return (
    <>
      <p>{taskCount} tasks will enter the queue. Independent tasks run in parallel as crew slots become free; dependent tasks wait for their prerequisites to merge.</p>
      <label className="goal-check">
        <input type="checkbox" checked={autoMerge} onChange={(e) => onChange(e.target.checked)} />
        <span>Merge goal tasks automatically when checks and acceptance pass. This pre-approves every task and waives visual review, including conflict resolutions.</span>
      </label>
      <p className="muted">
        {autoMerge
          ? "Failed checks, unfinished scope and unmet acceptance still need your decision."
          : "Each completed task waits for your review and merge approval. Its dependent tasks remain queued until it lands."}
      </p>
    </>
  );
}

const CancelFields = () => (
  <p>Cancel queued and running goal work. Already merged changes remain in the repository. A merge in progress must finish before cancellation.</p>
);

/** Send back, approve or cancel a goal's plan, each confirmed in a sheet. */
export function GoalDecision({ goal, mode, onClose, onSaved }: { goal: Goal; mode: GoalDecisionMode; onClose: () => void; onSaved: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const { busy, error, submit } = useSubmit();
  const form = useId();
  const label = DECISION_LABEL[mode];
  const decide = {
    feedback: () => api.goalFeedback(goal.id, goal.revision, feedback),
    approve: () => api.approveGoal(goal.id, goal.revision, autoMerge),
    cancel: () => api.cancelGoal(goal.id, goal.revision),
  }[mode];
  const save = () => submit(async () => {
    await decide();
    onSaved();
    onClose();
  });
  return (
    <Sheet onClose={onClose}>
      <SheetHead title={label} subtitle={goal.title} />
      <SheetBody>
        <form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {mode === "feedback" && <FeedbackFields value={feedback} onChange={setFeedback} />}
          {mode === "approve" && <ApproveFields taskCount={goal.plan?.tasks.length} autoMerge={autoMerge} onChange={setAutoMerge} />}
          {mode === "cancel" && <CancelFields />}
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}>
        <button className="btn btn-primary" form={form} disabled={busy || (mode === "feedback" && !feedback.trim())}>{busy ? "Saving…" : label}</button>
      </SheetFoot>
    </Sheet>
  );
}
