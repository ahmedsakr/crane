import { useId, useState } from "react";
import { localStartTime, startPresets, startProblem, tomorrowMorning, untilLabel, whenLabel } from "../lib/schedule";

const NOW = "now";
const CUSTOM = "custom";

/**
 * When something should start. Presets cover what people usually mean; "Pick a
 * time" is there for the rest, already filled in. The line underneath always
 * says what the choice means, so a wrong date shows before anything is saved.
 *
 * `value` is null for now, or a local `YYYY-MM-DDTHH:mm`.
 */
export function ScheduleFields({ value, onChange, disabled }: {
  value: string | null; onChange: (value: string | null) => void; disabled?: boolean;
}) {
  const name = useId();
  const presets = startPresets();
  const [choice, setChoice] = useState(() =>
    value === null ? NOW : presets.find((p) => p.value === value)?.id ?? CUSTOM);
  const [date = "", time = ""] = value?.split("T") ?? [];
  const pick = (id: string, next: string | null) => {
    setChoice(id);
    onChange(next);
  };
  const option = (id: string, label: string, next: string | null) => (
    <label className="pill" key={id}>
      <input type="radio" name={name} checked={choice === id} onChange={() => pick(id, next)} />
      <span>{label}</span>
    </label>
  );

  return (
    <fieldset className="when" disabled={disabled}>
      <legend className="when-label">Start</legend>
      <div className="pills" role="radiogroup" aria-label="Start">
        {option(NOW, "Now", null)}
        {presets.map((p) => option(p.id, p.label, p.value))}
        {option(CUSTOM, "Pick a time", value ?? tomorrowMorning())}
      </div>
      {choice === CUSTOM && (
        <div className="when-custom">
          <label className="tuning-field">
            <span>Date</span>
            <input className="input" type="date" required value={date} min={localStartTime(new Date().toISOString()).slice(0, 10)}
              onChange={(e) => onChange(`${e.target.value}T${time}`)} />
          </label>
          <label className="tuning-field">
            <span>Time</span>
            <input className="input" type="time" required value={time}
              onChange={(e) => onChange(`${date}T${e.target.value}`)} />
          </label>
        </div>
      )}
      <StartLine value={value} />
    </fieldset>
  );
}

/** What the chosen start time means, or what's wrong with it. */
function StartLine({ value }: { value: string | null }) {
  if (value === null) return <p className="when-summary muted">Starts as soon as an agent is free.</p>;
  const problem = startProblem(value);
  if (problem) return <p className="when-summary error-text" role="alert">{problem}</p>;
  const at = new Date(value).getTime();
  return (
    <>
      <p className="when-summary">
        <strong>{whenLabel(at)}</strong>
        <span className="muted"> · {untilLabel(at)}</span>
      </p>
      <small className="when-note">Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Starts when an agent is free after this time and prerequisites are met. The factory must be running and unpaused.</small>
    </>
  );
}
