import type { TaskGates } from "../lib/api";

/** What the operator typed: task ids, one acceptance criterion per line, and one check command per line. */
export interface GateText {
  prerequisites: string;
  acceptance: string;
  acceptanceChecks: string;
}

export const NO_GATES: GateText = { prerequisites: "", acceptance: "", acceptanceChecks: "" };

export function parseGates(text: GateText): Required<TaskGates> {
  return {
    prerequisites: text.prerequisites.split(/[\s,]+/).filter(Boolean),
    acceptance: text.acceptance.split("\n").map((l) => l.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, "")).filter(Boolean),
    // Exact commands, so a leading "-" or number stays as typed.
    acceptanceChecks: text.acceptanceChecks.split("\n").map((l) => l.trim()).filter(Boolean),
  };
}

/**
 * Prerequisites, acceptance criteria and acceptance checks for a new task,
 * folded away until opened: most tasks have none, but when they matter they're
 * execution gates.
 */
export function GateFields({ value, onChange, disabled }: { value: GateText; onChange: (v: GateText) => void; disabled?: boolean }) {
  const { prerequisites, acceptance, acceptanceChecks } = parseGates(value);
  const set = [prerequisites.length && `${prerequisites.length} prerequisite${prerequisites.length === 1 ? "" : "s"}`,
    acceptance.length && `${acceptance.length} acceptance ${acceptance.length === 1 ? "criterion" : "criteria"}`,
    acceptanceChecks.length && `${acceptanceChecks.length} acceptance check${acceptanceChecks.length === 1 ? "" : "s"}`].filter(Boolean);
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
        <label className="tuning-field">
          <span>Acceptance checks</span>
          <textarea className="input" rows={2} value={value.acceptanceChecks} disabled={disabled} spellCheck={false}
            placeholder="One of the repo's checks per line, like npm test"
            onChange={(e) => onChange({ ...value, acceptanceChecks: e.target.value })} />
          <small>Met only when Crane sees the check pass on the finished work, so the agent doesn't report on it.</small>
        </label>
      </div>
    </details>
  );
}
