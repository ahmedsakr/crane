/** Null means now; an empty string means later, with the time still to be chosen. */
export function ScheduleFields({ value, onChange, disabled }: {
  value: string | null; onChange: (value: string | null) => void; disabled?: boolean;
}) {
  return (
    <div className="gates-fields schedule-fields">
      <label className="tuning-field">
        <span>Start</span>
        <select className="input" value={value === null ? "now" : "later"} disabled={disabled}
          onChange={(e) => onChange(e.target.value === "now" ? null : "")}>
          <option value="now">Now</option>
          <option value="later">Later</option>
        </select>
      </label>
      {value !== null && (
        <label className="tuning-field">
          <span>Date and time</span>
          <input className="input" type="datetime-local" required value={value} disabled={disabled}
            onChange={(e) => onChange(e.target.value)} />
        </label>
      )}
      <small>Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Starts when an agent is free after this time and prerequisites are met. The factory must be running and unpaused.</small>
    </div>
  );
}
