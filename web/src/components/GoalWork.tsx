import { GOAL_TASK_PHASES, STATUS_LABEL, driverLabel, goalTaskPhase, goalWaves, isDriverName, isTunable, settingsLabel, type Goal, type GoalPlan, type GoalTask, type GoalTaskPhase, type Task, type TaskRunOptions } from "@crane/contracts";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { ChangeAgentSheet } from "./ChangeAgentSheet";
import { GoalChip } from "./GoalProgressBar";

/** A task whose agent can still change, and what saving does in each case. */
export type AgentTarget =
  | { kind: "plan"; item: GoalTask }
  | { kind: "queued"; item: GoalTask; task: Task }
  | { kind: "retry"; item: GoalTask; task: Task };

export interface GoalWorkActions {
  busy: boolean;
  onChangeAgent: (target: AgentTarget) => void;
  onRetry: (task: Task) => void;
}

function runSummary(run: Pick<GoalTask, "model" | "effort"> & { driver: string | null }): string {
  if (!run.driver) return `Factory default${run.model || run.effort ? ` · ${settingsLabel(run)}` : ""}`;
  if (isDriverName(run.driver) && !isTunable(run.driver)) return driverLabel(run.driver);
  return `${driverLabel(run.driver)} · ${settingsLabel(run) ?? "Default model"}`;
}

/** What it's waiting on, in the plan's words. Once running or finished, dependencies no longer matter. */
function dependencyNote(plan: GoalPlan, item: GoalTask, taskFor: (key: string) => Task | undefined, approved: boolean): string | null {
  const titleOf = (key: string) => plan.tasks.find((t) => t.key === key)?.title ?? key;
  if (!approved) return item.dependsOn.length ? `After: ${item.dependsOn.map(titleOf).join(", ")}` : "Can start right away";
  const task = taskFor(item.key);
  if (task?.status !== "queued") return null;
  const waiting = task.prerequisitesWaivedAt ? [] : item.dependsOn.filter((key) => goalTaskPhase(taskFor(key) ?? { status: "failed", branch: null }) !== "done");
  return waiting.length ? `Waiting for: ${waiting.map(titleOf).join(", ")}` : "Ready for a free agent";
}

function TaskActions({ goal, item, task, actions }: { goal: Goal; item: GoalTask; task?: Task; actions: GoalWorkActions }) {
  const change = (target: AgentTarget) => <button className="btn btn-ghost btn-sm" data-goal-task-action="change-agent" disabled={actions.busy} onClick={() => actions.onChangeAgent(target)}>Change agent</button>;
  if (!goal.approvedAt) return ["needs_review", "blocked"].includes(goal.status) ? <div className="goal-task-actions">{change({ kind: "plan", item })}</div> : null;
  if (!task) return null;
  if (task.status === "queued") return <div className="goal-task-actions">{change({ kind: "queued", item, task })}</div>;
  if (task.status === "needs_review") return <div className="goal-task-actions"><Link className="btn btn-crane btn-sm" to={`/tasks/${task.id}`}>Review</Link></div>;
  if (goalTaskPhase(task) === "review") return <div className="goal-task-actions"><Link className="btn btn-crane btn-sm" to={`/tasks/${task.id}`}>Merge</Link></div>;
  if (goalTaskPhase(task) !== "stopped" || !["active", "blocked"].includes(goal.status)) return null;
  return <div className="goal-task-actions">
    <button className="btn btn-sm" disabled={actions.busy} onClick={() => actions.onRetry(task)}>Retry task</button>
    {change({ kind: "retry", item, task })}
  </div>;
}

export function GoalTaskCard({ goal, plan, item, taskFor, actions }: { goal: Goal; plan: GoalPlan; item: GoalTask; taskFor: (key: string) => Task | undefined; actions: GoalWorkActions }) {
  const task = taskFor(item.key);
  const phase = goal.approvedAt ? taskPhase(goal, task) : null;
  const note = dependencyNote(plan, item, taskFor, !!goal.approvedAt);
  return <article className={`card card-pad goal-task ${phase ? `goal-task-tinted goal-phase-${phase}` : ""}`}>
    <div className="goal-task-head">
      <h3 className="card-title">{task ? <Link to={`/tasks/${task.id}`}>{item.title}</Link> : item.title}</h3>
      {phase && <GoalChip phase={phase} label={task ? STATUS_LABEL[task.status] : "No record"} />}
    </div>
    <p className="goal-task-run">{runSummary(task ?? item)}</p>
    {note && <p className="muted goal-task-note">{note}</p>}
    <details><summary>Brief and acceptance</summary><p className="goal-prose">{item.brief}</p><ul>{item.acceptance.map((c) => <li key={c}>{c}</li>)}{item.acceptanceChecks?.map((c) => <li key={c}>Check must pass: <span className="mono">{c}</span></li>)}</ul><p className="muted goal-prose">{item.rationale}</p></details>
    <TaskActions goal={goal} item={item} task={task} actions={actions} />
  </article>;
}

/** A task with no record is why an executing goal is held; retention can also clear them from a finished one. */
function taskPhase(goal: Goal, task: Task | undefined): GoalTaskPhase {
  if (task) return goalTaskPhase(task);
  return goal.status === "completed" ? "done" : "stopped";
}

/** Before approval the decision is the order, so a draft reads as numbered steps. */
export function GoalPlanSteps({ goal, plan, taskFor, actions }: { goal: Goal; plan: GoalPlan; taskFor: (key: string) => Task | undefined; actions: GoalWorkActions }) {
  return <>
    <p className="muted">Tasks in a step can run together, up to your active crew capacity. Each task starts as soon as its own dependencies have merged.</p>
    {goalWaves(plan).map((wave, i) => <section className="goal-section" key={i}>
      <h2 className="section-title">Step {i + 1} <span className="count">{wave.length > 1 ? `${wave.length} tasks, together` : "1 task"}</span></h2>
      <div className="goal-task-grid">{wave.map((item) => <GoalTaskCard key={item.key} goal={goal} plan={plan} item={item} taskFor={taskFor} actions={actions} />)}</div>
    </section>)}
  </>;
}

const GROUPS: { title: string; phases: GoalTaskPhase[]; fold?: boolean }[] = [
  { title: "Needs you", phases: ["stopped", "review"] },
  { title: "Working now", phases: ["working"] },
  { title: "Up next", phases: ["waiting"] },
  { title: "Done", phases: ["done"], fold: true },
];

/** Once work is running the decision is what needs you, so tasks group by where they stand. */
export function GoalTaskGroups({ goal, plan, taskFor, actions }: { goal: Goal; plan: GoalPlan; taskFor: (key: string) => Task | undefined; actions: GoalWorkActions }) {
  const ordered = goalWaves(plan).flat();
  const groups = GROUPS.map((group) => ({ ...group,
    items: ordered.filter((item) => group.phases.includes(taskPhase(goal, taskFor(item.key))))
      .sort((a, b) => GOAL_TASK_PHASES.indexOf(taskPhase(goal, taskFor(a.key))) - GOAL_TASK_PHASES.indexOf(taskPhase(goal, taskFor(b.key)))) }))
    .filter((group) => group.items.length > 0);
  return <>{groups.map((group) => {
    const cards = <div className="goal-task-grid">{group.items.map((item) => <GoalTaskCard key={item.key} goal={goal} plan={plan} item={item} taskFor={taskFor} actions={actions} />)}</div>;
    const title = <h2 className="section-title">{group.title} <span className="count">{group.items.length}</span></h2>;
    if (!group.fold) return <section className="goal-section" key={group.title}>{title}{cards}</section>;
    return <details className="goal-section goal-group-fold" key={group.title} open={groups.length === 1}><summary>{title}</summary>{cards}</details>;
  })}</>;
}

/** The one sheet for changing an agent: what saving does depends on how far the task has got. */
export function GoalAgentSheet({ goal, target, onClose, onSaved }: { goal: Goal; target: AgentTarget; onClose: () => void; onSaved: () => void }) {
  const { item } = target;
  const save = (run: Required<TaskRunOptions>): Promise<unknown> => {
    if (target.kind === "plan") return api.changeGoalPlanAgent(goal.id, goal.revision, item.key, run);
    if (target.kind === "queued") return api.changeAgent(target.task.id, run);
    return api.retryGoalTask(goal.id, goal.revision, target.task.id, run);
  };
  const notes = {
    plan: "This changes the draft plan. Nothing runs until you approve it.",
    queued: "This applies when a crew member picks the task up. Its place in the plan doesn't change.",
    retry: "This starts a new attempt on this agent and reconnects the tasks waiting for it.",
  };
  return <ChangeAgentSheet title={item.title} run={target.kind === "plan" ? item : target.task}
    allowDefault={target.kind !== "plan"} canKeep={target.kind === "retry"} saveLabel={target.kind === "retry" ? "Retry task" : "Change agent"}
    note={notes[target.kind]} onSave={async (run) => { await save(run); onSaved(); }} onClose={onClose} />;
}
