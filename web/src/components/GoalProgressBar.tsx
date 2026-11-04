import { GOAL_TASK_PHASES, type Goal, type GoalProgress, type GoalTaskPhase } from "@crane/contracts";

const phaseLabel = (phase: GoalTaskPhase, count: number): string => {
  if (phase === "review") return count === 1 ? "needs you" : "need you";
  return phase;
};

/** A goal's status uses the same colours as its tasks: blue moving, yellow or red needs you, green finished. */
export const GOAL_STATUS: Record<Goal["status"], { label: string; phase: GoalTaskPhase }> = {
  researching: { label: "Researching", phase: "working" },
  needs_review: { label: "Review plan", phase: "review" },
  active: { label: "In progress", phase: "working" },
  completed: { label: "Completed", phase: "done" },
  blocked: { label: "Needs attention", phase: "stopped" },
  cancelled: { label: "Cancelled", phase: "waiting" },
};

export function progressText(progress: GoalProgress): string {
  const total = GOAL_TASK_PHASES.reduce((sum, phase) => sum + progress[phase], 0);
  const rest = GOAL_TASK_PHASES.filter((phase) => phase !== "done" && progress[phase] > 0).map((phase) => `${progress[phase]} ${phaseLabel(phase, progress[phase])}`);
  return [`${progress.done} of ${total} done`, ...rest].join(" · ");
}

export function GoalChip({ phase, label }: { phase: GoalTaskPhase; label: string }) {
  return <span className={`chip goal-chip goal-phase-${phase}`}><span className={phase === "working" ? "dot dot-running" : "dot"} aria-hidden />{label}</span>;
}

/** Most urgent first, so what needs the operator sits at the start of the bar. */
export function GoalProgressBar({ progress }: { progress: GoalProgress }) {
  return <div className="goal-bar" role="img" aria-label={progressText(progress)}>
    {GOAL_TASK_PHASES.filter((phase) => progress[phase] > 0).map((phase) =>
      <span key={phase} className={`goal-phase-${phase}`} style={{ flexGrow: progress[phase] }} />)}
  </div>;
}

export function GoalProgressLegend({ progress }: { progress: GoalProgress }) {
  return <ul className="goal-legend">
    {GOAL_TASK_PHASES.filter((phase) => progress[phase] > 0).map((phase) =>
      <li key={phase} className={`goal-phase-${phase}`}><span className="dot" aria-hidden /><strong>{progress[phase]}</strong> {phaseLabel(phase, progress[phase])}</li>)}
  </ul>;
}
