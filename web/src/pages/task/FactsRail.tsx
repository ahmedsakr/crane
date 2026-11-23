import { Link } from "react-router-dom";
import { actorLabel, type TaskDetail } from "@crane/contracts";
import { AUTONOMY_LABEL, lookoutsLabel, settingsLabel, STATUS_LABEL } from "../../lib/api";
import { ago, duration, usd } from "../../lib/format";
import { CREW_ROUTE } from "../../lib/runners";
import { Runs } from "./Runs";
import { driverName, showsRuns, waitingForOfflineRunner, type TaskView } from "./task-view";

function FollowUpFacts({ source }: { source: TaskView["source"] }) {
  if (!source) return null;
  return <>
    <dt>Follow-up to</dt>
    <dd>
      <Link className="mono" to={`/tasks/${source.id}`} title={STATUS_LABEL[source.status]}>{source.id}</Link>
      <span className="muted"> · {source.title}</span>
    </dd>
    {source.finding && <>
      <dt>Finding</dt>
      <dd>{source.finding}</dd>
    </>}
  </>;
}

function PrerequisiteFacts({ prerequisites, waived }: { prerequisites: TaskView["prerequisites"]; waived: boolean }) {
  if (prerequisites.length === 0) return null;
  return <>
    <dt>Prerequisites</dt>
    <dd>
      {prerequisites.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ", "}
          <Link className="mono" to={`/tasks/${p.id}`} title={`${p.title} · ${p.met ? "landed" : STATUS_LABEL[p.status]}`}>{p.id}</Link>
        </span>
      ))}
      {waived && <span className="muted"> · waived</span>}
    </dd>
  </>;
}

function Facts({ detail, view }: { detail: TaskDetail; view: TaskView }) {
  const { task, agent } = detail;
  const settings = settingsLabel(task);
  const lookouts = lookoutsLabel(task.lookouts);
  return (
    <dl className="facts">
      <dt>Task</dt>
      <dd className="mono">{task.id}</dd>
      {task.createdBy && <>
        <dt>Started by</dt>
        <dd>{actorLabel(task.createdBy)}</dd>
      </>}
      <dt>Freedom</dt>
      <dd>{AUTONOMY_LABEL[task.autonomy]}</dd>
      <dt>Agent</dt>
      <dd>{[agent?.name, driverName(view.usedDriver)].filter(Boolean).join(" on ") || "—"}</dd>
      <dt>Runs on</dt>
      <dd>{task.runnerLabel ?? (task.runnerId ? "Assigned container" : CREW_ROUTE)}</dd>
      {settings && <>
        <dt>Model settings</dt>
        <dd>{settings}</dd>
      </>}
      {lookouts && <>
        <dt>Also looks for</dt>
        <dd>{lookouts}</dd>
      </>}
      <dt>Started</dt>
      <dd>{task.startedAt ? ago(task.startedAt) : "Not yet"}</dd>
      <dt>Took</dt>
      <dd className="tabular">{duration(task.startedAt, task.finishedAt)}</dd>
      {task.costUsd > 0 && <>
        <dt>Cost</dt>
        <dd className="tabular">{usd(task.costUsd)}</dd>
      </>}
      {task.branch && <>
        <dt>Branch</dt>
        <dd className="mono">{task.branch}</dd>
      </>}
      <FollowUpFacts source={view.source} />
      <PrerequisiteFacts prerequisites={view.prerequisites} waived={!!task.prerequisitesWaivedAt} />
    </dl>
  );
}

/** The side rail's reference: the task's facts, what its runs cost, and the instruction it was given. */
export function FactsRail({ detail, view }: { detail: TaskDetail; view: TaskView }) {
  return <>
    {waitingForOfflineRunner(detail.task) && (
      <p className="notice">Waiting for this container to come online.</p>
    )}
    <div className="card card-pad">
      <Facts detail={detail} view={view} />
      {showsRuns(detail.runs) && <Runs runs={detail.runs} />}
    </div>

    <div className="card card-pad">
      <h3 className="card-title" id="task-instruction">Instruction</h3>
      <div className="task-widget-body task-instruction" role="region" aria-labelledby="task-instruction" tabIndex={0}>
        {detail.task.brief}
      </div>
    </div>
  </>;
}
