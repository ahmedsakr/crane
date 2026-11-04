import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { errorMessage, EFFORT_LEVELS, STATUS_LABEL, driverLabel, goalProgress, validateGoalPlan, type DriverName, type Goal, type GoalListItem, type GoalPlan, type GoalTask, type Task } from "@crane/contracts";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { plural } from "../lib/format";
import { useDrivers, usePoll } from "../lib/hooks";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../components/Sheet";
import { AgentFields, NO_AGENT_CHOICE, agentRunOptions } from "../components/AgentFields";
import { GOAL_STATUS, GoalChip, GoalProgressBar, GoalProgressLegend, progressText } from "../components/GoalProgressBar";
import { GoalAgentSheet, GoalPlanSteps, GoalTaskGroups, type AgentTarget, type GoalWorkActions } from "../components/GoalWork";

function NewGoalSheet({ onClose }: { onClose: () => void }) {
  const { overview } = useApp();
  const { drivers } = useDrivers();
  const navigate = useNavigate();
  const form = useId();
  const [outcome, setOutcome] = useState("");
  const [repoId, setRepo] = useState(overview?.repos.length === 1 ? overview.repos[0]!.id : "");
  const [agent, setAgent] = useState(NO_AGENT_CHOICE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true); setError("");
    try {
      const goal = await api.createGoal({ outcome, repoId, ...agentRunOptions(agent, drivers ?? []) });
      onClose(); navigate(`/goals/${goal.id}`);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <SheetHead title="New goal" subtitle="Describe the outcome. A research agent will propose the work, order and agent assignments for your review." />
    <SheetBody><form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="tuning-field">Desired outcome<textarea className="input" rows={6} required maxLength={20000} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What should be possible when this goal is complete?" /></label>
      <label className="tuning-field">Repository<select className="input" required value={repoId} onChange={(e) => setRepo(e.target.value)}><option value="">Choose a repo</option>{overview?.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <details><summary>Research agent</summary><div className="sheet-fields goal-options">
        <AgentFields value={agent} onChange={setAgent} drivers={drivers ?? []} />
      </div></details>
      <p className="muted">Research is read-only. Implementation waits until you approve a plan.</p>
    </form></SheetBody>
    <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}><button className="btn btn-primary" form={form} disabled={busy || !outcome.trim() || !repoId}>{busy ? "Starting…" : "Research goal"}</button></SheetFoot>
  </Sheet>;
}

const LIST_GROUPS: { title: string; statuses: Goal["status"][]; fold?: boolean }[] = [
  { title: "Needs you", statuses: ["needs_review", "blocked"] },
  { title: "In progress", statuses: ["researching", "active"] },
  { title: "Finished", statuses: ["completed", "cancelled"], fold: true },
];

function GoalRow({ goal: g, repoName }: { goal: GoalListItem; repoName?: string }) {
  const status = GOAL_STATUS[g.status];
  // A backend older than this page sends no progress; read it as empty until it restarts.
  const progress = g.progress ?? goalProgress([]);
  const planned = g.plannedTasks ? `${plural(g.plannedTasks, "task")} planned` : "Planning";
  return <Link className={`card card-pad goal-list-item goal-phase-${status.phase}`} to={`/goals/${g.id}`}>
    <div className="goal-list-copy"><h3 className="card-title">{g.title}</h3><p className="muted">{[repoName, g.taskCount ? progressText(progress) : planned].filter(Boolean).join(" · ")}</p></div>
    <GoalChip phase={status.phase} label={status.label} />
    {g.taskCount > 0 && <GoalProgressBar progress={progress} />}
  </Link>;
}

export function Goals() {
  const { data, error, refresh } = usePoll(api.goals);
  const { overview } = useApp();
  const [creating, setCreating] = useState(false);
  const groups = LIST_GROUPS.map((group) => ({ ...group, goals: (data ?? []).filter((g) => group.statuses.includes(g.status)) })).filter((group) => group.goals.length > 0);
  return <>
    <div className="page-head"><h1 className="page-title">Goals</h1><button className="btn btn-primary" onClick={() => setCreating(true)}>New goal</button></div>
    <p className="muted">Set an outcome, refine the plan, then let the crew work through it.</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p className="muted">Loading…</p>}
    {data?.length === 0 && <div className="card card-pad"><h2 className="card-title">Start with the outcome</h2><p>A research agent discovers the tasks, dependencies and useful refactoring. You can give feedback until the plan is ready.</p></div>}
    {groups.map((group) => {
      const title = <h2 className="section-title">{group.title} <span className="count">{group.goals.length}</span></h2>;
      const rows = <div className="goal-list">{group.goals.map((g) => <GoalRow key={g.id} goal={g} repoName={overview?.repos.find((r) => r.id === g.repoId)?.name} />)}</div>;
      if (!group.fold) return <section className="goal-section" key={group.title}>{title}{rows}</section>;
      return <details className="goal-section goal-group-fold" key={group.title} open={groups.length === 1}><summary>{title}</summary>{rows}</details>;
    })}
    {creating && <NewGoalSheet onClose={() => { setCreating(false); refresh(); }} />}
  </>;
}

function PlanEditor({ goal, onClose, onSaved }: { goal: Goal; onClose: () => void; onSaved: () => void }) {
  const [plan, setPlan] = useState<GoalPlan>(() => structuredClone(goal.plan!));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const patch = (key: string, change: Partial<GoalTask>) => setPlan((p) => ({ ...p, tasks: p.tasks.map((t) => t.key === key ? { ...t, ...change } : t) }));
  const save = async () => {
    setError(""); setBusy(true);
    try { await api.editGoalPlan(goal.id, goal.revision, validateGoalPlan({ ...plan,
      improvements: plan.improvements.filter((s) => s.trim()), tasks: plan.tasks.map((t) => ({ ...t, acceptance: t.acceptance.filter((s) => s.trim()), acceptanceChecks: t.acceptanceChecks?.filter((s) => s.trim()) })) })); onSaved(); onClose(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const add = () => {
    let n = plan.tasks.length + 1;
    while (plan.tasks.some((t) => t.key === `task-${n}`)) n++;
    setPlan({ ...plan, tasks: [...plan.tasks, { key: `task-${n}`, title: "New task", brief: "", dependsOn: [], driver: "codex", model: null, effort: "high", rationale: "", acceptance: [] }] });
  };
  return <Sheet onClose={onClose}>
    <SheetHead title="Edit plan" subtitle="Changes stay in the draft until you approve it. Dependencies must form a valid order." />
    <SheetBody><form className="sheet-fields" id={form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="tuning-field">Summary<textarea className="input" rows={3} value={plan.summary} onChange={(e) => setPlan({ ...plan, summary: e.target.value })} required /></label>
      <label className="tuning-field">Approach<textarea className="input" rows={5} value={plan.approach} onChange={(e) => setPlan({ ...plan, approach: e.target.value })} required /></label>
      <label className="tuning-field">Optional improvements, one per line<textarea className="input" rows={3} value={plan.improvements.join("\n")} onChange={(e) => setPlan({ ...plan, improvements: e.target.value.split("\n") })} /></label>
      {plan.tasks.map((t) => <details key={t.key} className="goal-editor-task"><summary>{t.title} <span className="muted">· {t.key}</span></summary><div className="sheet-fields goal-options">
        <label className="tuning-field">Title<input className="input" value={t.title} required onChange={(e) => patch(t.key, { title: e.target.value })} /></label>
        <label className="tuning-field">Brief<textarea className="input" rows={5} value={t.brief} required onChange={(e) => patch(t.key, { brief: e.target.value })} /></label>
        <label className="tuning-field">Agent<select className="input" value={t.driver} onChange={(e) => patch(t.key, { driver: e.target.value as DriverName, model: null, effort: null })}>{Object.keys(EFFORT_LEVELS).map((d) => <option key={d} value={d}>{driverLabel(d)}</option>)}</select></label>
        <label className="tuning-field">Model<input className="input" value={t.model ?? ""} placeholder="Agent default" onChange={(e) => patch(t.key, { model: e.target.value || null })} /></label>
        <label className="tuning-field">Effort<select className="input" value={t.effort ?? ""} onChange={(e) => patch(t.key, { effort: e.target.value || null })}><option value="">Agent default</option>{EFFORT_LEVELS[t.driver].map((v) => <option key={v}>{v}</option>)}</select></label>
        <label className="tuning-field">Why this assignment and order<textarea className="input" rows={3} value={t.rationale} required onChange={(e) => patch(t.key, { rationale: e.target.value })} /></label>
        <label className="tuning-field">Acceptance criteria, one per line<textarea className="input" rows={4} value={t.acceptance.join("\n")} required onChange={(e) => patch(t.key, { acceptance: e.target.value.split("\n") })} /></label>
        <label className="tuning-field">Acceptance checks, one of the repo's checks per line<textarea className="input" rows={2} spellCheck={false} value={(t.acceptanceChecks ?? []).join("\n")} onChange={(e) => patch(t.key, { acceptanceChecks: e.target.value.split("\n") })} /></label>
        <fieldset className="goal-dependencies"><legend>Wait for these tasks to merge</legend>{plan.tasks.filter((other) => other.key !== t.key).map((other) => <label key={other.key}><input type="checkbox" checked={t.dependsOn.includes(other.key)} onChange={(e) => patch(t.key, { dependsOn: e.target.checked ? [...t.dependsOn, other.key] : t.dependsOn.filter((k) => k !== other.key) })} />{other.title}</label>)}</fieldset>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((item) => item.key !== t.key).map((item) => ({ ...item, dependsOn: item.dependsOn.filter((key) => key !== t.key) })) })}>Remove task and its dependencies</button>
      </div></details>)}
      <button type="button" className="btn btn-ghost" disabled={plan.tasks.length >= 40} onClick={add}>Add task</button>
    </form></SheetBody>
    <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : `${plan.tasks.length} tasks`}><button className="btn btn-primary" form={form} disabled={busy}>{busy ? "Saving…" : "Save plan"}</button></SheetFoot>
  </Sheet>;
}

function GoalDecision({ goal, mode, onClose, onSaved }: { goal: Goal; mode: "feedback" | "approve" | "cancel"; onClose: () => void; onSaved: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const form = useId();
  const label = mode === "feedback" ? "Review feedback" : mode === "approve" ? "Approve plan" : "Cancel goal";
  const save = async () => {
    setBusy(true); setError("");
    try {
      if (mode === "feedback") await api.goalFeedback(goal.id, goal.revision, feedback);
      else if (mode === "approve") await api.approveGoal(goal.id, goal.revision, autoMerge);
      else await api.cancelGoal(goal.id, goal.revision);
      onSaved(); onClose();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <SheetHead title={label} subtitle={goal.title} />
    <SheetBody><form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {mode === "feedback" ? <><label className="tuning-field">What should change?<textarea className="input" rows={6} required maxLength={20000} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Adjust the scope, split a task, choose another agent, or ask for more evidence…" /></label><p className="muted">The research agent will review your feedback and return a full revised plan for approval.</p></> : mode === "approve" ? <>
        <p>{goal.plan?.tasks.length} tasks will enter the queue. Independent tasks run in parallel as crew slots become free; dependent tasks wait for their prerequisites to merge.</p>
        <label className="goal-check"><input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} /><span>Merge goal tasks automatically when checks and acceptance pass. This pre-approves every task and waives visual review, including conflict resolutions.</span></label>
        <p className="muted">{autoMerge ? "Failed checks, unfinished scope and unmet acceptance still need your decision." : "Each completed task waits for your review and merge approval. Its dependent tasks remain queued until it lands."}</p>
      </> : <p>Cancel queued and running goal work. Already merged changes remain in the repository. A merge in progress must finish before cancellation.</p>}
    </form></SheetBody>
    <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}><button className="btn btn-primary" form={form} disabled={busy || (mode === "feedback" && !feedback.trim())}>{busy ? "Saving…" : label}</button></SheetFoot>
  </Sheet>;
}

/** The brief behind the work. Before approval it's what's being decided; afterwards it steps aside for progress. */
function GoalBrief({ goal: g, research }: { goal: Goal; research: Task | null }) {
  const researchLink = research && <Link to={`/tasks/${research.id}`}>Open research · {STATUS_LABEL[research.status]}</Link>;
  const approach = g.plan && <details><summary>Approach and repository evidence</summary><p className="goal-prose">{g.plan.approach}</p></details>;
  if (g.approvedAt) {
    return <details className="goal-section goal-brief">
      <summary>Outcome and plan</summary>
      <p className="goal-prose">{g.outcome}</p>
      {g.plan && <p className="goal-prose">{g.plan.summary}</p>}
      {approach}
      {researchLink}
    </details>;
  }
  return <>
    <section className="card card-pad goal-overview"><h2 className="card-title">Desired outcome</h2><p className="goal-prose">{g.outcome}</p>
      <p className="muted">{g.status === "researching" ? "The research agent is reviewing the repository. Implementation has not started." : "Review the scope, ordering and agent choices. Give feedback as often as needed before approval."}</p>
      {researchLink}
    </section>
    {g.plan && <section className="goal-section"><h2 className="card-title">The plan</h2><p className="goal-prose">{g.plan.summary}</p>{approach}</section>}
  </>;
}

function GoalProgressCard({ goal: g, tasks }: { goal: Goal; tasks: Task[] }) {
  const progress = goalProgress(tasks);
  return <section className="card card-pad goal-progress">
    <p className="goal-progress-count"><strong>{progress.done}</strong> of {g.tasks.length} tasks done</p>
    <GoalProgressBar progress={progress} />
    <GoalProgressLegend progress={progress} />
    <p className="muted">{g.autoMerge ? "Automatic merging approved" : "Review each task before merge"}</p>
  </section>;
}

export function GoalPage() {
  const { id = "" } = useParams();
  const { data, error, refresh } = usePoll(() => api.goal(id), 2000, [id]);
  const [sheet, setSheet] = useState<{ goal: Goal; mode: "feedback" | "approve" | "cancel" | "edit" } | null>(null);
  const [agentSheet, setAgentSheet] = useState<{ goal: Goal; target: AgentTarget } | null>(null);
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  if (!data) return <p role={error ? "alert" : "status"}>{error ?? "Loading…"}</p>;
  const { goal: g, tasks, research } = data;
  const editable = !g.approvedAt && ["needs_review", "blocked"].includes(g.status);
  const status = GOAL_STATUS[g.status];
  const taskFor = (key: string) => {
    const link = g.tasks.find((t) => t.key === key);
    return tasks.find((t) => t.id === link?.taskId);
  };
  const retry = async (task: Task) => {
    setRetrying(true); setActionError("");
    try { await api.retryGoalTask(g.id, g.revision, task.id); refresh(); }
    catch (err) { setActionError(errorMessage(err)); } finally { setRetrying(false); }
  };
  const actions: GoalWorkActions = { busy: retrying, onChangeAgent: (target) => setAgentSheet({ goal: g, target }), onRetry: (task) => void retry(task) };
  const cancelGoal = !["completed", "cancelled"].includes(g.status) && <button className="btn btn-ghost" onClick={() => setSheet({ goal: g, mode: "cancel" })}>Cancel goal</button>;
  return <>
    <Link className="muted" to="/goals">← Goals</Link>
    <div className="page-head goal-head"><h1 className="page-title">{g.title}</h1><GoalChip phase={status.phase} label={status.label} /></div>
    {(error || actionError) && <p role="alert" className="error-text">{error || actionError}</p>}
    {g.error && <div className="notice" role="status">{g.error}</div>}
    {!g.approvedAt && <div className="goal-actions">
      {editable && <><button data-goal-action="approve" className="btn btn-crane" disabled={g.status !== "needs_review" || !g.plan} onClick={() => setSheet({ goal: g, mode: "approve" })}>Approve plan</button><button data-goal-action="feedback" className="btn" onClick={() => setSheet({ goal: g, mode: "feedback" })}>Give feedback</button>{g.plan && <button data-goal-action="edit" className="btn btn-ghost" onClick={() => setSheet({ goal: g, mode: "edit" })}>Edit plan</button>}</>}
      {cancelGoal}
    </div>}
    {g.approvedAt && <GoalProgressCard goal={g} tasks={tasks} />}
    {!g.approvedAt && <GoalBrief goal={g} research={research} />}
    {g.plan && (g.approvedAt
      ? <GoalTaskGroups goal={g} plan={g.plan} taskFor={taskFor} actions={actions} />
      : <GoalPlanSteps goal={g} plan={g.plan} taskFor={taskFor} actions={actions} />)}
    {g.approvedAt && <GoalBrief goal={g} research={research} />}
    {g.plan && g.plan.improvements.length > 0 && <details className="goal-section"><summary>Optional improvements · {g.plan.improvements.length}</summary><ul>{g.plan.improvements.map((s) => <li key={s} className="goal-prose">{s}</li>)}</ul><p className="muted">These suggestions are outside the approved task scope unless included in a task.</p></details>}
    {g.feedback.length > 0 && <details className="goal-section"><summary>Feedback history · {g.feedback.length}</summary>{g.feedback.map((f) => <div className="goal-feedback" key={f.revision}><p className="goal-prose">{f.text}</p><Link to={`/tasks/${f.taskId}`}>Research revision {f.revision}</Link></div>)}</details>}
    {g.approvedAt && cancelGoal && <div className="goal-actions">{cancelGoal}</div>}
    {sheet && (sheet.mode === "edit" ? <PlanEditor goal={sheet.goal} onClose={() => setSheet(null)} onSaved={refresh} /> : <GoalDecision goal={sheet.goal} mode={sheet.mode} onClose={() => setSheet(null)} onSaved={refresh} />)}
    {agentSheet && <GoalAgentSheet goal={agentSheet.goal} target={agentSheet.target} onClose={() => setAgentSheet(null)} onSaved={refresh} />}
  </>;
}
