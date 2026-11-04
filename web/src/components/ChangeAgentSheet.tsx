import { errorMessage } from "@crane/contracts";
import { useId, useState, type ReactNode } from "react";
import { type TaskRunOptions } from "../lib/api";
import { useDrivers } from "../lib/hooks";
import { AgentFields, agentChoice, agentRunOptions, chosenAgent } from "./AgentFields";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "./Sheet";

/** Choose who runs one task. The caller decides what saving does, and says so in `note`. */
export function ChangeAgentSheet({ title, run, allowDefault, saveLabel = "Change agent", canKeep, note, onSave, onClose }: {
  /** The task's title, so the operator can see which one this changes. */
  title: string;
  run: TaskRunOptions;
  allowDefault?: boolean;
  saveLabel?: string;
  /** Saving without a change does something, as a retry does. */
  canKeep?: boolean;
  note: ReactNode;
  onSave: (run: Required<TaskRunOptions>) => Promise<unknown>;
  onClose: () => void;
}) {
  const { drivers } = useDrivers();
  const form = useId();
  const [choice, setChoice] = useState(() => agentChoice(run));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Simulated is only a choice in a demo, or for work already assigned to it.
  const offered = (drivers ?? []).filter((d) => d.name !== "simulated" || d.isDefault || d.name === run.driver);
  const before = agentChoice(run);
  const unchanged = choice.driver === before.driver && choice.model.trim() === before.model && choice.effort === before.effort;
  const save = async () => {
    setBusy(true); setError("");
    try { await onSave(agentRunOptions(choice, offered)); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <SheetHead title="Change agent" subtitle={title} />
    <SheetBody><form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <AgentFields value={choice} onChange={setChoice} drivers={offered} disabled={busy} allowDefault={allowDefault} />
      <p className="muted">{note}</p>
    </form></SheetBody>
    <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}>
      <button className="btn btn-primary" form={form} disabled={busy || !drivers || !chosenAgent(offered, choice.driver)?.available || (unchanged && !canKeep)}>
        {busy ? "Saving…" : saveLabel}
      </button>
    </SheetFoot>
  </Sheet>;
}
