import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, KIND_LABEL, type DriverInfo, type Task, type TaskDetail, type TaskEvent } from "../lib/api";
import { useDrivers, usePoll, useTick } from "../lib/hooks";
import { useAction } from "../lib/action";
import { useToast } from "../lib/toast";
import { useApp } from "../lib/app-context";
import { ChangeAgentSheet } from "../components/ChangeAgentSheet";
import { Section } from "../components/Section";
import { StatusChip } from "../components/Status";
import { AcceptanceSection } from "./task/AcceptanceSection";
import { BlockedSection } from "./task/BlockedSection";
import { DecisionBar } from "./task/DecisionBar";
import { FactsRail } from "./task/FactsRail";
import { FindingsSection } from "./task/FindingsSection";
import { MergeCard } from "./task/MergeCard";
import { MergedCard } from "./task/MergedCard";
import { PreApprovalCard } from "./task/PreApprovalCard";
import { PrerequisitesCard } from "./task/PrerequisitesCard";
import { RetryActions } from "./task/RetryActions";
import { ScreenshotsSection } from "./task/ScreenshotsSection";
import { StartTimeCard } from "./task/StartTimeCard";
import type { TaskActions } from "./task/task-actions";
import { TaskChanges } from "./task/TaskChanges";
import { TaskSummaryLine } from "./task/TaskSummaryLine";
import { isWorking, mergingSummary, scheduleOrigin, taskView, type TaskView } from "./task/task-view";
import { Timeline } from "./task/Timeline";
import { useTaskDiff } from "./task/useTaskDiff";
import { useTaskEvents } from "./task/useTaskEvents";
import { ValidationRuns } from "./task/ValidationRuns";
import { VisualReviewCard } from "./task/VisualReviewCard";

interface PageParts {
  detail: TaskDetail;
  view: TaskView;
  events: TaskEvent[];
  drivers: DriverInfo[] | null;
  actions: TaskActions;
}

function TaskHeader({ detail, view }: Pick<PageParts, "detail" | "view">) {
  const { task, repo, goalId } = detail;
  return <>
    <div className="meta-line">
      <StatusChip status={task.status} />
      <span className="chip">{KIND_LABEL[task.kind]}</span>
      {repo && <span className="chip">{repo.name}</span>}
      {view.canPreApprove && task.preApprovedAt && <span className="chip chip-ok">Pre-approved</span>}
    </div>
    <h1 className="detail-title">{task.title}</h1>
    {goalId && <p className="notice">Part of a goal. <Link to={`/goals/${goalId}`}>Review the plan, progress or retry from the goal</Link></p>}
  </>;
}

/** Decision first: everything the operator can act on, before the record of what happened. */
function TaskDecisions({ detail, view, events, actions }: Omit<PageParts, "drivers">) {
  const { task, agent } = detail;
  const { main } = view;
  return <>
    <VisualReviewCard task={task} actions={actions} />
    <DecisionBar task={task} main={main} mergeError={view.merge?.error} unmet={view.unmet.length} actions={actions} />
    {task.scheduleId && <p className="muted">{scheduleOrigin(task, events)}</p>}
    <TaskSummaryLine task={task} agent={agent} waitingOn={view.waitingOn} />
    <StartTimeCard task={task} actions={actions} />
    <PrerequisitesCard taskId={task.id} waitingOn={view.waitingOn} main={main} actions={actions} />
    {view.canPreApprove && <PreApprovalCard task={task} main={main} acceptanceGate={view.acceptanceGate} actions={actions} />}
  </>;
}

function TaskRail({ detail, view, drivers, actions, onChangeAgent }: Omit<PageParts, "events"> & { onChangeAgent: () => void }) {
  const { task, repo, goalId } = detail;
  return (
    <aside className="rail">
      <FactsRail detail={detail} view={view} />
      <RetryActions task={task} inGoal={!!goalId} drivers={drivers} usedDriver={view.usedDriver} onChangeAgent={onChangeAgent} actions={actions} />
      <MergeCard task={task} repo={repo} main={view.main} actions={actions} />
      <MergedCard merged={task.status === "merged"} merge={view.merge} main={view.main} />
    </aside>
  );
}

function TaskActivity({ task, events }: { task: Task; events: TaskEvent[] }) {
  return (
    <Section title={<>
      Activity
      {(task.status === "running" || task.status === "merging") && <span className="dot dot-running" title="Live" />}
    </>}>
      <Timeline events={events} />
    </Section>
  );
}

function ChangeAgent({ task, onSaved, onClose }: { task: Task; onSaved: () => void; onClose: () => void }) {
  const toast = useToast();
  return (
    <ChangeAgentSheet title={task.title} run={task} note="This applies when a crew member picks the task up."
      onSave={async (next) => { await api.changeAgent(task.id, next); toast({ text: "Agent changed" }); onSaved(); }}
      onClose={onClose} />
  );
}

export function TaskPage() {
  const { id = "" } = useParams();
  const { refresh: refreshApp } = useApp();
  const { data, error, refresh } = usePoll<TaskDetail>(() => api.task(id), 3000, [id]);
  const [showDiff, setShowDiff] = useState(false);
  const [finding, setFinding] = useState<number | null>(null);
  const [changingAgent, setChangingAgent] = useState(false);
  const reload = () => {
    refresh();
    refreshApp();
  };
  const { busy, run } = useAction(reload);
  const { drivers } = useDrivers();
  useTick(5000);
  useEffect(() => {
    setFinding(null);
    setShowDiff(false);
  }, [id]);
  const events = useTaskEvents(id, data);

  // While an agent works on its branch, follow its changes as they happen, uncommitted work included.
  // Otherwise read the branch's changes once they're asked for.
  const working = isWorking(data?.task);
  const changes = useTaskDiff(id, working || (showDiff && !!data?.task.branch), working);

  if (error) return <p className="muted" style={{ paddingTop: 40 }}>{error}</p>;
  if (!data) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;
  const { task, repo, agent } = data;
  const view = taskView(data, events);
  const actions = { busy: !!busy, run };
  const parts = { detail: data, view, actions };

  return (
    <article>
      <Link className="back" to="/tasks">
        ← Tasks
      </Link>
      <div className="detail">
        <div style={{ minWidth: 0 }}>
          <TaskHeader detail={data} view={view} />
          <TaskDecisions {...parts} events={events} />
          <AcceptanceSection task={task} acceptance={view.acceptance} acceptanceChecks={view.acceptanceChecks} unmet={view.unmet.length} />
          <ScreenshotsSection task={task} />
          <ValidationRuns task={task} />
          {task.status === "merging" && <p className="muted">{mergingSummary(agent, view.main)}</p>}
          <BlockedSection blocked={data.blocked} taskId={task.id} repoName={repo?.name} onDone={reload} />
          <FindingsSection task={task} followUps={view.followUps} drivers={drivers} open={finding} onOpenChange={setFinding} refresh={refresh} actions={actions} />
          <TaskChanges task={task} working={working} changes={changes} open={showDiff} onOpenChange={setShowDiff} />
          <TaskActivity task={task} events={events} />
        </div>
        <TaskRail {...parts} drivers={drivers} onChangeAgent={() => setChangingAgent(true)} />
      </div>
      {changingAgent && task.status === "queued" && <ChangeAgent task={task} onSaved={refresh} onClose={() => setChangingAgent(false)} />}
    </article>
  );
}
