import { useState } from "react";
import { UNSHIPPED_STATUSES, prerequisiteMet, type DriverInfo, type FollowUpOptions, type Lookout, type Task } from "../lib/api";
import { AgentFields, agentChoice, agentRunOptions, chosenAgent } from "./AgentFields";
import { GateFields, NO_GATES, parseGates } from "./GateFields";
import { LookoutFields } from "./LookoutFields";

/** Opened from a finding so scheduling choices stay next to the work they apply to. */
export function FollowUpForm({ task, drivers, busy, onSubmit, onClose }: {
  task: Task;
  drivers: DriverInfo[];
  busy: boolean;
  onSubmit: (opts: FollowUpOptions) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(() => agentChoice(task));
  // A finding from a change that hasn't landed may build on it, so the follow-up
  // waits for it by default (the operator can clear that). A failed, cancelled,
  // or declined task keeps its branch only for the record, so nothing to wait for.
  const waitsForTask = !!task.branch && !prerequisiteMet(task) && !UNSHIPPED_STATUSES.includes(task.status);
  const [gates, setGates] = useState(waitsForTask ? { ...NO_GATES, prerequisites: task.id } : NO_GATES);
  const [lookouts, setLookouts] = useState<Lookout[]>([]);
  const selected = chosenAgent(drivers, choice.driver);

  return (
    <form className="follow-up-form" aria-label="Schedule change" onSubmit={e => {
      e.preventDefault();
      onSubmit({ ...agentRunOptions(choice, drivers), ...parseGates(gates), lookouts });
    }}>
      <div className="tuning">
        <AgentFields value={choice} onChange={setChoice} drivers={drivers} disabled={busy} autoFocus />
      </div>
      <LookoutFields value={lookouts} onChange={setLookouts} disabled={busy} />
      <GateFields value={gates} onChange={setGates} disabled={busy} />
      <p>
        Applies to this follow-up only. Changes wait for your review.
        {waitsForTask && " It starts once this task lands, since the finding may build on its changes."}
      </p>
      <div className="tuning-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !selected?.available}>
          {busy ? "Scheduling…" : "Make this change"}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
