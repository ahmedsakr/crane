import { useId, useState } from "react";
import { validateGoalPlan, type Goal, type GoalPlan } from "@crane/contracts";
import { api } from "../../lib/api";
import { addTask, canAddTask, patchTask, removeTask, splitLines, withoutBlankLines } from "../../lib/goal-plan";
import { useSubmit } from "../../lib/use-submit";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";
import { PlanTaskEditor } from "./PlanTaskEditor";

export function PlanEditor({ goal, onClose, onSaved }: { goal: Goal; onClose: () => void; onSaved: () => void }) {
  const [plan, setPlan] = useState<GoalPlan>(() => structuredClone(goal.plan!));
  const { busy, error, submit } = useSubmit();
  const form = useId();
  const save = () => submit(async () => {
    await api.editGoalPlan(goal.id, goal.revision, validateGoalPlan(withoutBlankLines(plan)));
    onSaved();
    onClose();
  });
  return (
    <Sheet onClose={onClose}>
      <SheetHead title="Edit plan" subtitle="Changes stay in the draft until you approve it. Dependencies must form a valid order." />
      <SheetBody>
        <form className="sheet-fields" id={form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="tuning-field">
            Summary
            <textarea className="input" rows={3} value={plan.summary} onChange={(e) => setPlan({ ...plan, summary: e.target.value })} required />
          </label>
          <label className="tuning-field">
            Approach
            <textarea className="input" rows={5} value={plan.approach} onChange={(e) => setPlan({ ...plan, approach: e.target.value })} required />
          </label>
          <label className="tuning-field">
            Optional improvements, one per line
            <textarea className="input" rows={3} value={plan.improvements.join("\n")} onChange={(e) => setPlan({ ...plan, improvements: splitLines(e.target.value) })} />
          </label>
          {plan.tasks.map((t) => (
            <PlanTaskEditor
              key={t.key}
              task={t}
              others={plan.tasks.filter((other) => other.key !== t.key)}
              onChange={(change) => setPlan((p) => patchTask(p, t.key, change))}
              onRemove={() => setPlan(removeTask(plan, t.key))}
            />
          ))}
          <button type="button" className="btn btn-ghost" disabled={!canAddTask(plan)} onClick={() => setPlan(addTask(plan))}>Add task</button>
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : `${plan.tasks.length} tasks`}>
        <button className="btn btn-primary" form={form} disabled={busy}>{busy ? "Saving…" : "Save plan"}</button>
      </SheetFoot>
    </Sheet>
  );
}
