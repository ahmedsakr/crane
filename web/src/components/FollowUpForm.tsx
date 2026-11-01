import { useId, useState } from "react";
import { driverLabel, type DriverInfo, type Task, type TaskGates, type TaskRunOptions } from "../lib/api";
import { GateFields, NO_GATES, parseGates } from "./GateFields";

/** Opened from a finding so scheduling choices stay next to the work they apply to. */
export function FollowUpForm({ task, drivers, busy, onSubmit, onClose }: {
  task: Task;
  drivers: DriverInfo[];
  busy: boolean;
  onSubmit: (opts: TaskRunOptions & TaskGates) => void;
  onClose: () => void;
}) {
  const [driver, setDriver] = useState(task.driver ?? "");
  const [model, setModel] = useState(task.model ?? "");
  const [effort, setEffort] = useState(task.effort ?? "");
  const [gates, setGates] = useState(NO_GATES);
  const listId = useId();
  const defaultAgent = drivers.find(d => d.isDefault);
  const selected = driver ? drivers.find(d => d.name === driver) : defaultAgent;
  const tunable = !!selected?.efforts.length;

  return (
    <form className="follow-up-form" aria-label="Schedule change" onSubmit={e => {
      e.preventDefault();
      // Pin the agent when tuning it, so a later default change cannot apply
      // this agent's model or effort to a different one.
      onSubmit({
        driver: tunable && (model.trim() || effort) ? selected!.name : driver || null,
        model: tunable ? model.trim() || null : null,
        effort: tunable ? effort || null : null,
        ...parseGates(gates),
      });
    }}>
      <div className="tuning">
        <label className="tuning-field">
          <span>Agent</span>
          <select className="input" autoFocus value={driver} disabled={busy} onChange={e => {
            setDriver(e.target.value);
            setModel("");
            setEffort("");
          }}>
            <option value="">Factory default{defaultAgent ? ` · ${defaultAgent.label}` : ""}</option>
            {driver && !drivers.some(d => d.name === driver) && <option value={driver}>{driverLabel(driver)} · unavailable</option>}
            {drivers.map(d => <option key={d.name} value={d.name} disabled={!d.available}>
              {d.label}{d.available ? "" : " · not installed"}
            </option>)}
          </select>
        </label>
        {tunable && <>
          <label className="tuning-field">
            <span>Model</span>
            <input className="input" list={listId} value={model} disabled={busy}
              placeholder={selected.model ?? "Agent default"} onChange={e => setModel(e.target.value)} />
            {selected.models.length > 0 && <datalist id={listId}>
              {selected.models.map(m => <option key={m} value={m} />)}
            </datalist>}
          </label>
          <label className="tuning-field">
            <span>Model effort</span>
            <select className="input" value={effort} disabled={busy} onChange={e => setEffort(e.target.value)}>
              <option value="">Agent default{selected.effort ? ` · ${selected.effort}` : ""}</option>
              {selected.efforts.map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        </>}
      </div>
      <GateFields value={gates} onChange={setGates} disabled={busy} />
      <p>Applies to this follow-up only. Changes wait for your review.</p>
      <div className="tuning-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !selected?.available}>
          {busy ? "Scheduling…" : "Make this change"}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
