import type { Agent, PrerequisiteState, Task } from "@crane/contracts";
import { useApp } from "../../lib/app-context";
import { pendingSummary } from "./task-view";

/** The report's summary once there is one; before that, what the task is waiting for. */
export function TaskSummaryLine({ task, agent, waitingOn }: { task: Task; agent: Agent | null; waitingOn: PrerequisiteState[] }) {
  const { overview } = useApp();
  if (task.report) return <p className="summary">{task.report.summary}</p>;
  const postmortemCrew = (overview?.agents ?? []).filter((a) => a.runsPostmortems).map((a) => a.name);
  const text = pendingSummary(task, { agent, waitingOn, postmortemCrew });
  return text ? <p className="summary muted">{text}</p> : null;
}
