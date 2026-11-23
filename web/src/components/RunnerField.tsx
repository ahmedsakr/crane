import type { RunnerSummary } from "@crane/contracts";
import { CREW_ROUTE, runnerStatus } from "../lib/runners";

export function RunnerField({ runners, value, onChange, required, disabled, label }: {
  runners: RunnerSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
  required: boolean;
  disabled: boolean;
  label?: string;
}) {
  const current = runners.find((runner) => runner.id === value);
  return <label className="tuning-field runner-field">
    <span>Runs on</span>
    <select className="input" value={value ?? ""} required={required} disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}>
      <option value="" disabled={required}>{required ? "Choose a container" : CREW_ROUTE}</option>
      {value && !current && <option value={value}>{label ?? "Assigned container"}</option>}
      {runners.map((runner) => <option key={runner.id} value={runner.id}>{runner.name}</option>)}
    </select>
    {current && <small className="muted">{runnerStatus(current)}</small>}
    {required && !runners.length && !value && <small className="muted">Add a container from Account → Containers.</small>}
  </label>;
}
