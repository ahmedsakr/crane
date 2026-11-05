import type { Lookout } from "../lib/api";
import { startSummary } from "../lib/schedule";
import { GateFields, NO_GATES, type GateText } from "./GateFields";
import { LookoutFields } from "./LookoutFields";
import { ScheduleFields } from "./ScheduleFields";

/** Everything about a new task the operator sets directly, rather than correcting the factory's reading. */
export interface InstructSettings {
  driver: string | null;
  gates: GateText;
  lookouts: Lookout[];
  startTime: string | null;
  preApprove: boolean;
}

export const NO_SETTINGS: InstructSettings = { driver: null, gates: NO_GATES, lookouts: [], startTime: null, preApprove: false };

function PreApproveField({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled: boolean }) {
  return (
    <details className="gates">
      <summary>Merge when it passes <span className="muted">· {checked ? "On" : "Off"}</span></summary>
      <div className="gates-fields">
        <label>
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
          {" "}Pre-approve this task
        </label>
        <small>Crane merges it once its run, acceptance criteria, and checks pass. Pre-approval also waives visual review, including conflict resolutions. You can undo pre-approval before the run finishes.</small>
      </div>
    </details>
  );
}

/** Lookouts, start time, pre-approval and gates for a new task. Pre-approval only shows for work that can merge. */
export function InstructOptions({ settings, change, preApprovable, busy }: {
  settings: InstructSettings;
  change: (settings: Partial<InstructSettings>) => void;
  preApprovable: boolean;
  busy: boolean;
}) {
  return (
    <>
      <LookoutFields value={settings.lookouts} onChange={(lookouts) => change({ lookouts })} disabled={busy} />
      <details className="gates">
        <summary>Start time <span className="muted">· {startSummary(settings.startTime)}</span></summary>
        <ScheduleFields value={settings.startTime} onChange={(startTime) => change({ startTime })} disabled={busy} />
      </details>
      {preApprovable && (
        <PreApproveField checked={settings.preApprove} onChange={(preApprove) => change({ preApprove })} disabled={busy} />
      )}
      <GateFields value={settings.gates} onChange={(gates) => change({ gates })} disabled={busy} />
    </>
  );
}
