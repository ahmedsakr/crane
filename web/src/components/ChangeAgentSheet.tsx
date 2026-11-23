import { errorMessage } from "@crane/contracts";
import { useId, useState, type ReactNode } from "react";
import { type TaskRunOptions } from "../lib/api";
import { useDrivers } from "../lib/hooks";
import { CONTAINER_REQUIRED, runnerDrivers } from "../lib/runners";
import { useRunnerRouting } from "../lib/use-runner-routing";
import { AgentFields, agentChoice, agentRunOptions, chosenAgent, NO_AGENT_CHOICE } from "./AgentFields";
import { RunnerField } from "./RunnerField";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "./Sheet";

/** Choose who runs one task. The caller decides what saving does, and says so in `note`. */
export function ChangeAgentSheet({ title, run, route, allowDefault, saveLabel = "Change agent", canKeep, note, onSave, onClose }: {
  /** The task's title, so the operator can see which one this changes. */
  title: string;
  run: TaskRunOptions;
  /** Present for queued tasks whose route can be edited. */
  route?: { runnerId: string | null; runnerLabel?: string };
  allowDefault?: boolean;
  saveLabel?: string;
  /** Saving without a change does something, as a retry does. */
  canKeep?: boolean;
  note: ReactNode;
  onSave: (run: Required<TaskRunOptions> & { runnerId?: string | null }) => Promise<unknown>;
  onClose: () => void;
}) {
  const { drivers } = useDrivers();
  const routing = useRunnerRouting(!!route);
  const form = useId();
  const [choice, setChoice] = useState(() => agentChoice(run));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runnerId, setRunnerId] = useState(route?.runnerId ?? null);
  const routeChanged = !!route && runnerId !== route.runnerId;
  const required = !!route && routing.preference?.required === true;
  const runner = routing.runners.find((r) => r.id === runnerId);
  // Simulated is only a choice in a demo, or for work already assigned to it.
  const offered = runnerId ? runnerDrivers(runner) : (drivers ?? []).filter((d) => d.name !== "simulated" || d.isDefault || d.name === run.driver);
  const before = agentChoice(run);
  const unchanged = choice.driver === before.driver && choice.model.trim() === before.model && choice.effort === before.effort;
  const available = (runnerId && !choice.driver) || chosenAgent(offered, choice.driver)?.available;
  const routeError = required && !runnerId ? CONTAINER_REQUIRED : routing.error;
  const disabled = busy || !!routeError || (routing.signedIn && !routing.preference) || !available || (unchanged && !routeChanged && !canKeep);
  const save = async () => {
    if (disabled) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...agentRunOptions(choice, offered), runnerId: routeChanged ? runnerId : undefined });
      onClose();
    }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <SheetHead title="Change agent" subtitle={title} />
    <SheetBody><form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {route && routing.signedIn && <RunnerField runners={routing.runners} value={runnerId} required={required} label={route.runnerLabel}
        disabled={busy || !routing.preference} onChange={(id) => {
          setRunnerId(id);
          setChoice(id === route.runnerId ? before : NO_AGENT_CHOICE);
        }} />}
      <AgentFields value={choice} onChange={setChoice} drivers={offered} disabled={busy} allowDefault={allowDefault}
        defaultLabel={runnerId ? "Container default" : "Factory default"} />
      <p className="muted">{note}</p>
    </form></SheetBody>
    <SheetFoot note={(routeError || error) && <span role="alert" className="error-text">{routeError || error}</span>}>
      <button className="btn btn-primary" form={form} disabled={disabled}>
        {busy ? "Saving…" : saveLabel}
      </button>
    </SheetFoot>
  </Sheet>;
}
