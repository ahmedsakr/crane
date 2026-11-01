import { useId } from "react";
import { LOOKOUT, LOOKOUTS, type Lookout } from "../lib/api";

/**
 * What else the agent should look out for while it works, as toggles. Off by
 * default; what the agent spots comes back as findings, not a bigger change.
 */
export function LookoutFields({ value, onChange, disabled }: {
  value: Lookout[];
  onChange: (v: Lookout[]) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const toggle = (l: Lookout) => onChange(LOOKOUTS.filter((x) => (x === l ? !value.includes(x) : value.includes(x))));
  return (
    <div className="lookouts" role="group" aria-labelledby={labelId}>
      <span className="lookouts-label" id={labelId}>Also look for</span>
      <span className="lookouts-options">
        {LOOKOUTS.map((l) => (
          <button key={l} type="button" className="toggle-chip" aria-pressed={value.includes(l)} disabled={disabled}
            title={LOOKOUT[l].hint} onClick={() => toggle(l)}>
            {LOOKOUT[l].label}
          </button>
        ))}
      </span>
      {value.length > 0 && <small className="lookouts-note muted">Reported as findings you can turn into follow-ups. The change stays on the task.</small>}
    </div>
  );
}
