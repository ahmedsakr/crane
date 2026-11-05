import { Link } from "react-router-dom";
import { goalProgress, type Goal, type Task } from "@crane/contracts";
import { GoalProgressBar, GoalProgressLegend } from "../../components/GoalProgressBar";

export function GoalProgressCard({ goal: g, tasks }: { goal: Goal; tasks: Task[] }) {
  const progress = goalProgress(tasks);
  return (
    <section className="card card-pad goal-progress">
      <p className="goal-progress-count"><strong>{progress.done}</strong> of {g.tasks.length} tasks done</p>
      <GoalProgressBar progress={progress} />
      <GoalProgressLegend progress={progress} />
      <p className="muted">{g.autoMerge ? "Automatic merging approved" : "Review each task before merge"}</p>
    </section>
  );
}

export function GoalImprovements({ improvements }: { improvements: string[] }) {
  if (improvements.length === 0) return null;
  return (
    <details className="goal-section">
      <summary>Optional improvements · {improvements.length}</summary>
      <ul>{improvements.map((s) => <li key={s} className="goal-prose">{s}</li>)}</ul>
      <p className="muted">These suggestions are outside the approved task scope unless included in a task.</p>
    </details>
  );
}

export function GoalFeedbackHistory({ feedback }: { feedback: Goal["feedback"] }) {
  if (feedback.length === 0) return null;
  return (
    <details className="goal-section">
      <summary>Feedback history · {feedback.length}</summary>
      {feedback.map((f) => (
        <div className="goal-feedback" key={f.revision}>
          <p className="goal-prose">{f.text}</p>
          <Link to={`/tasks/${f.taskId}`}>Research revision {f.revision}</Link>
        </div>
      ))}
    </details>
  );
}
