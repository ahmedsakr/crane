import type { ReactNode } from "react";
import { EFFORT_LEVELS, driverLabel, type DriverName, type GoalTask } from "@crane/contracts";
import { splitLines, withDependency } from "../../lib/goal-plan";

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="tuning-field">{label}{children}</label>
);

function DependencyFields({ task, others, onChange }: { task: GoalTask; others: GoalTask[]; onChange: (dependsOn: string[]) => void }) {
  return (
    <fieldset className="goal-dependencies">
      <legend>Wait for these tasks to merge</legend>
      {others.map((other) => (
        <label key={other.key}>
          <input type="checkbox" checked={task.dependsOn.includes(other.key)} onChange={(e) => onChange(withDependency(task, other.key, e.target.checked))} />
          {other.title}
        </label>
      ))}
    </fieldset>
  );
}

function AgentChoiceFields({ task, onChange }: { task: GoalTask; onChange: (change: Partial<GoalTask>) => void }) {
  return (
    <>
      <Field label="Agent">
        <select className="input" value={task.driver} onChange={(e) => onChange({ driver: e.target.value as DriverName, model: null, effort: null })}>
          {Object.keys(EFFORT_LEVELS).map((d) => <option key={d} value={d}>{driverLabel(d)}</option>)}
        </select>
      </Field>
      <Field label="Model">
        <input className="input" value={task.model ?? ""} placeholder="Agent default" onChange={(e) => onChange({ model: e.target.value || null })} />
      </Field>
      <Field label="Effort">
        <select className="input" value={task.effort ?? ""} onChange={(e) => onChange({ effort: e.target.value || null })}>
          <option value="">Agent default</option>
          {EFFORT_LEVELS[task.driver].map((v) => <option key={v}>{v}</option>)}
        </select>
      </Field>
    </>
  );
}

/** One plan task, folded until opened. */
export function PlanTaskEditor({ task: t, others, onChange, onRemove }: {
  task: GoalTask;
  /** The tasks this one could wait for. */
  others: GoalTask[];
  onChange: (change: Partial<GoalTask>) => void;
  onRemove: () => void;
}) {
  return (
    <details className="goal-editor-task">
      <summary>{t.title} <span className="muted">· {t.key}</span></summary>
      <div className="sheet-fields goal-options">
        <Field label="Title">
          <input className="input" value={t.title} required onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Brief">
          <textarea className="input" rows={5} value={t.brief} required onChange={(e) => onChange({ brief: e.target.value })} />
        </Field>
        <AgentChoiceFields task={t} onChange={onChange} />
        <Field label="Why this assignment and order">
          <textarea className="input" rows={3} value={t.rationale} required onChange={(e) => onChange({ rationale: e.target.value })} />
        </Field>
        <Field label="Acceptance criteria, one per line">
          <textarea className="input" rows={4} value={t.acceptance.join("\n")} required onChange={(e) => onChange({ acceptance: splitLines(e.target.value) })} />
        </Field>
        <Field label="Acceptance checks, one of the repo's checks per line">
          <textarea className="input" rows={2} spellCheck={false} value={(t.acceptanceChecks ?? []).join("\n")} onChange={(e) => onChange({ acceptanceChecks: splitLines(e.target.value) })} />
        </Field>
        <DependencyFields task={t} others={others} onChange={(dependsOn) => onChange({ dependsOn })} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove task and its dependencies</button>
      </div>
    </details>
  );
}
