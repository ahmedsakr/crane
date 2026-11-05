import { Link } from "react-router-dom";
import type { GoalListItem } from "@crane/contracts";
import { listProgress, plannedText } from "../../lib/goal-plan";
import { GOAL_STATUS, GoalChip, GoalProgressBar, progressText } from "../../components/GoalProgressBar";

export function GoalRow({ goal: g, repoName }: { goal: GoalListItem; repoName?: string }) {
  const status = GOAL_STATUS[g.status];
  const progress = listProgress(g);
  return (
    <Link className={`card card-pad goal-list-item goal-phase-${status.phase}`} to={`/goals/${g.id}`}>
      <div className="goal-list-copy">
        <h3 className="card-title">{g.title}</h3>
        <p className="muted">{[repoName, g.taskCount ? progressText(progress) : plannedText(g)].filter(Boolean).join(" · ")}</p>
      </div>
      <GoalChip phase={status.phase} label={status.label} />
      {g.taskCount > 0 && <GoalProgressBar progress={progress} />}
    </Link>
  );
}
