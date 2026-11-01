import { useState } from "react";
import { ScheduleFields } from "./ScheduleFields";
import { localStartTime, parseStartTime } from "../lib/schedule";

export function TaskScheduleForm({ scheduledAt, busy, onSave }: {
  scheduledAt: string | null; busy: boolean; onSave: (time: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState<string | null>(scheduledAt ? localStartTime(scheduledAt) : null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="gates">
      <summary>Change start time</summary>
      <form onSubmit={(e) => {
        e.preventDefault();
        try {
          const time = parseStartTime(value);
          setError(null);
          void onSave(time);
        } catch (err) { setError((err as Error).message); }
      }}>
        <ScheduleFields value={value} onChange={setValue} disabled={busy} />
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-quiet btn-sm" type="submit" disabled={busy} style={{ marginTop: 12 }}>Save start time</button>
      </form>
    </details>
  );
}
