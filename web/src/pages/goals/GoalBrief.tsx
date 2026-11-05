import { Link } from "react-router-dom";
import { STATUS_LABEL, type Goal, type Task } from "@crane/contracts";

/** The brief behind the work. Before approval it's what's being decided; afterwards it steps aside for progress. */
export function GoalBrief({ goal: g, research }: { goal: Goal; research: Task | null }) {
  const researchLink = research && <Link to={`/tasks/${research.id}`}>Open research · {STATUS_LABEL[research.status]}</Link>;
  const approach = g.plan && (
    <details>
      <summary>Approach and repository evidence</summary>
      <p className="goal-prose">{g.plan.approach}</p>
    </details>
  );
  if (g.approvedAt) {
    return (
      <details className="goal-section goal-brief">
        <summary>Outcome and plan</summary>
        <p className="goal-prose">{g.outcome}</p>
        {g.plan && <p className="goal-prose">{g.plan.summary}</p>}
        {approach}
        {researchLink}
      </details>
    );
  }
  return (
    <>
      <section className="card card-pad goal-overview">
        <h2 className="card-title">Desired outcome</h2>
        <p className="goal-prose">{g.outcome}</p>
        <p className="muted">
          {g.status === "researching"
            ? "The research agent is reviewing the repository. Implementation has not started."
            : "Review the scope, ordering and agent choices. Give feedback as often as needed before approval."}
        </p>
        {researchLink}
      </section>
      {g.plan && (
        <section className="goal-section">
          <h2 className="card-title">The plan</h2>
          <p className="goal-prose">{g.plan.summary}</p>
          {approach}
        </section>
      )}
    </>
  );
}
