import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Goal, GoalDetail, Task } from "@crane/contracts";
import { api } from "../lib/api";
import { isCancellable, isPlanEditable, taskForKey, type GoalDecisionMode } from "../lib/goal-plan";
import { usePoll } from "../lib/hooks";
import { useSubmit } from "../lib/use-submit";
import { GOAL_STATUS, GoalChip } from "../components/GoalProgressBar";
import { GoalAgentSheet, GoalPlanSteps, GoalTaskGroups, type AgentTarget, type GoalWorkActions } from "../components/GoalWork";
import { GoalBrief } from "./goals/GoalBrief";
import { GoalDecision } from "./goals/GoalDecision";
import { GoalFeedbackHistory, GoalImprovements, GoalProgressCard } from "./goals/GoalDetails";
import { PlanEditor } from "./goals/PlanEditor";

type PlanSheet = GoalDecisionMode | "edit";

const CancelGoalButton = ({ onCancel }: { onCancel: () => void }) => (
  <button className="btn btn-ghost" onClick={onCancel}>Cancel goal</button>
);

/** What the operator can do with a plan that hasn't been approved yet. */
function PlanActions({ goal: g, onOpen }: { goal: Goal; onOpen: (mode: PlanSheet) => void }) {
  return (
    <div className="goal-actions">
      {isPlanEditable(g) && (
        <>
          <button data-goal-action="approve" className="btn btn-crane" disabled={g.status !== "needs_review" || !g.plan} onClick={() => onOpen("approve")}>Approve plan</button>
          <button data-goal-action="feedback" className="btn" onClick={() => onOpen("feedback")}>Give feedback</button>
          {g.plan && <button data-goal-action="edit" className="btn btn-ghost" onClick={() => onOpen("edit")}>Edit plan</button>}
        </>
      )}
      {isCancellable(g) && <CancelGoalButton onCancel={() => onOpen("cancel")} />}
    </div>
  );
}

/** The plan's tasks, as steps to review before approval and as progress groups after. */
function GoalWork({ goal: g, tasks, actions }: { goal: Goal; tasks: Task[]; actions: GoalWorkActions }) {
  if (!g.plan) return null;
  const taskFor = (key: string) => taskForKey(g, tasks, key);
  return g.approvedAt
    ? <GoalTaskGroups goal={g} plan={g.plan} taskFor={taskFor} actions={actions} />
    : <GoalPlanSteps goal={g} plan={g.plan} taskFor={taskFor} actions={actions} />;
}

export function GoalView({ detail, pollError, refresh }: { detail: GoalDetail; pollError: string | null; refresh: () => void }) {
  const { goal: g, tasks, research } = detail;
  const [sheet, setSheet] = useState<{ goal: Goal; mode: PlanSheet } | null>(null);
  const [agentSheet, setAgentSheet] = useState<{ goal: Goal; target: AgentTarget } | null>(null);
  const { busy: retrying, error: actionError, submit } = useSubmit();
  const status = GOAL_STATUS[g.status];
  const openSheet = (mode: PlanSheet) => setSheet({ goal: g, mode });
  const actions: GoalWorkActions = {
    busy: retrying,
    onChangeAgent: (target) => setAgentSheet({ goal: g, target }),
    onRetry: (task) => void submit(async () => { await api.retryGoalTask(g.id, g.revision, task.id); refresh(); }),
  };
  const brief = <GoalBrief goal={g} research={research} />;
  return (
    <>
      <Link className="muted" to="/goals">← Goals</Link>
      <div className="page-head goal-head">
        <h1 className="page-title">{g.title}</h1>
        <GoalChip phase={status.phase} label={status.label} />
      </div>
      {(pollError || actionError) && <p role="alert" className="error-text">{pollError || actionError}</p>}
      {g.error && <div className="notice" role="status">{g.error}</div>}
      {g.approvedAt ? <GoalProgressCard goal={g} tasks={tasks} /> : <PlanActions goal={g} onOpen={openSheet} />}
      {!g.approvedAt && brief}
      <GoalWork goal={g} tasks={tasks} actions={actions} />
      {g.approvedAt && brief}
      {g.plan && <GoalImprovements improvements={g.plan.improvements} />}
      <GoalFeedbackHistory feedback={g.feedback} />
      {g.approvedAt && isCancellable(g) && <div className="goal-actions"><CancelGoalButton onCancel={() => openSheet("cancel")} /></div>}
      {sheet && (sheet.mode === "edit"
        ? <PlanEditor goal={sheet.goal} onClose={() => setSheet(null)} onSaved={refresh} />
        : <GoalDecision goal={sheet.goal} mode={sheet.mode} onClose={() => setSheet(null)} onSaved={refresh} />)}
      {agentSheet && <GoalAgentSheet goal={agentSheet.goal} target={agentSheet.target} onClose={() => setAgentSheet(null)} onSaved={refresh} />}
    </>
  );
}

export function GoalPage() {
  const { id = "" } = useParams();
  const { data, error, refresh } = usePoll(() => api.goal(id), 2000, [id]);
  if (!data) return <p role={error ? "alert" : "status"}>{error ?? "Loading…"}</p>;
  return <GoalView detail={data} pollError={error} refresh={refresh} />;
}
