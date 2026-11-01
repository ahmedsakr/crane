import type { TaskGates } from "../lib/api";

/** What the operator typed: task ids, and one acceptance criterion per line. */
export interface GateText {
  prerequisites: string;
  acceptance: string;
}

export const NO_GATES: GateText = { prerequisites: "", acceptance: "" };

export function parseGates(text: GateText): Required<TaskGates> {
  return {
    prerequisites: text.prerequisites.split(/[\s,]+/).filter(Boolean),
    acceptance: text.acceptance.split("\n").map((l) => l.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, "")).filter(Boolean),
  };
}

/**
 * Prerequisites and acceptance criteria for a new task, folded away until
 * opened: most tasks have neither, but when they matter they're execution gates.
 */
export function GateFields({ value, onChange, disabled }: { value: GateText; onChange: (v: GateText) => void; disabled?: boolean }) {
  const { prerequisites, acceptance } = parseGates(value);
  const set = [prerequisites.length && `${prerequisites.length} prerequisite${prerequisites.length === 1 ? "" : "s"}`,
    acceptance.length && `${acceptance.length} acceptance ${acceptance.length === 1 ? "criterion" : "criteria"}`].filter(Boolean);
  return (
    <details className="gates">
      <summary>Prerequisites and acceptance criteria{set.length ? <span className="muted"> · {set.join(", ")}</span> : null}</summary>
      <div className="gates-fields">
        <label className="tuning-field">
          <span>Prerequisites</span>
          <input className="input" value={value.prerequisites} disabled={disabled} spellCheck={false}
            placeholder="Task ids, like t-8cd9a5"
            onChange={(e) => onChange({ ...value, prerequisites: e.target.value })} />
          <small>It starts only once these land, unless you waive them.</small>
        </label>
        <label className="tuning-field">
          <span>Acceptance criteria</span>
          <textarea className="input" rows={3} value={value.acceptance} disabled={disabled}
            placeholder="One per line, each something you could check"
            onChange={(e) => onChange({ ...value, acceptance: e.target.value })} />
          <small>A pre-approved task merges on its own only when its report shows every one met.</small>
        </label>
      </div>
    </details>
  );
}
