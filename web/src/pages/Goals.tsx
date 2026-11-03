import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { errorMessage, EFFORT_LEVELS, STATUS_LABEL, driverLabel, goalWaves, validateGoalPlan, type DriverName, type Goal, type GoalPlan, type GoalTask } from "@crane/contracts";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useDrivers, usePoll } from "../lib/hooks";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../components/Sheet";

const LABEL: Record<Goal["status"], string> = { researching: "Researching", needs_review: "Review plan", active: "In progress", completed: "Completed", blocked: "Needs attention", cancelled: "Cancelled" };

function NewGoalSheet({ onClose }: { onClose: () => void }) {
  const { overview } = useApp();
  const { drivers } = useDrivers();
  const navigate = useNavigate();
  const form = useId();
  const [outcome, setOutcome] = useState("");
  const [repoId, setRepo] = useState(overview?.repos.length === 1 ? overview.repos[0]!.id : "");
  const [driver, setDriver] = useState<DriverName | "">("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true); setError("");
    try {
      const goal = await api.createGoal({ outcome, repoId, driver: driver || null, model: model || null, effort: effort || null });
      onClose(); navigate(`/goals/${goal.id}`);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Sheet onClose={onClose}>
    <SheetHead title="New goal" subtitle="Describe the outcome. A research agent will propose the work, order and agent assignments for your review." />
    <SheetBody><form id={form} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="tuning-field">Desired outcome<textarea className="input" rows={6} required maxLength={20000} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What should be possible when this goal is complete?" /></label>
      <label className="tuning-field">Repository<select className="input" required value={repoId} onChange={(e) => setRepo(e.target.value)}><option value="">Choose a repo</option>{overview?.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <details><summary>Research agent</summary><div className="sheet-fields goal-options">
        <label className="tuning-field">Agent<select className="input" value={driver} onChange={(e) => { setDriver(e.target.value as DriverName | ""); setModel(""); setEffort(""); }}><option value="">Factory default</option>{drivers?.filter((d) => d.available).map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}</select></label>
        {driver && driver !== "simulated" && <>
          <label className="tuning-field">Model<input className="input" value={model} maxLength={120} placeholder="Agent default" onChange={(e) => setModel(e.target.value)} /></label>
          <label className="tuning-field">Effort<select className="input" value={effort} onChange={(e) => setEffort(e.target.value)}><option value="">Agent default</option>{EFFORT_LEVELS[driver].map((v) => <option key={v}>{v}</option>)}</select></label>
        </>}
      </div></details>
      <p className="muted">Research is read-only. Implementation waits until you approve a plan.</p>
    </form></SheetBody>
    <SheetFoot note={error ? <span role="alert" className="error-text">{error}</span> : undefined}><button className="btn btn-primary" form={form} disabled={busy || !outcome.trim() || !repoId}>{busy ? "Starting…" : "Research goal"}</button></SheetFoot>
  </Sheet>;
}

export function Goals() {
  const { data, error, refresh } = usePoll(api.goals);
  const { overview } = useApp();
  const [creating, setCreating] = useState(false);
  return <>
    <div className="page-head"><h1 className="page-title">Goals</h1><button className="btn btn-primary" onClick={() => setCreating(true)}>New goal</button></div>
    <p className="muted">Set an outcome, refine the plan, then let the crew work through it.</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p className="muted">Loading…</p>}
    {data?.length === 0 && <div className="card card-pad"><h2 className="card-title">Start with the outcome</h2><p>A research agent discovers the tasks, dependencies and useful refactoring. You can give feedback until the plan is ready.</p></div>}
    <div className="goal-list">{data?.map((g) => <Link className="card card-pad goal-list-item" to={`/goals/${g.id}`} key={g.id}>
      <div><h2 className="card-title">{g.title}</h2><p className="muted">{overview?.repos.find((r) => r.id === g.repoId)?.name} · {g.taskCount ? `${g.taskCount} tasks` : "Planning"}</p></div>
      <span className={g.status === "needs_review" || g.status === "blocked" ? "goal-status needs-you" : "goal-status"}>{LABEL[g.status]}</span>
    </Link>)}</div>
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

export function GoalPage() {
  const { id = "" } = useParams();
  const { drivers } = useDrivers();
  const { data, error, refresh } = usePoll(() => api.goal(id), 2000, [id]);
  const [sheet, setSheet] = useState<{ goal: Goal; mode: "feedback" | "approve" | "cancel" | "edit" } | null>(null);
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  if (!data) return <p role={error ? "alert" : "status"}>{error ?? "Loading…"}</p>;
  const { goal: g, tasks, research } = data;
  const editable = !g.approvedAt && ["needs_review", "blocked"].includes(g.status);
  const retry = async (taskId: string, driver?: string) => {
    setRetrying(true); setActionError("");
    try { await api.retryGoalTask(g.id, g.revision, taskId, driver); refresh(); }
    catch (err) { setActionError(errorMessage(err)); } finally { setRetrying(false); }
  };
  return <>
    <Link className="muted" to="/goals">← Goals</Link>
    <div className="page-head goal-head"><h1 className="page-title">{g.title}</h1><span className="goal-status">{LABEL[g.status]}</span></div>
    {(error || actionError) && <p role="alert" className="error-text">{error || actionError}</p>}
    {g.error && <div className="notice" role="status">{g.error}</div>}
    <div className="goal-actions">
      {editable && <><button data-goal-action="approve" className="btn btn-primary" disabled={g.status !== "needs_review" || !g.plan} onClick={() => setSheet({ goal: g, mode: "approve" })}>Approve plan</button><button data-goal-action="feedback" className="btn" onClick={() => setSheet({ goal: g, mode: "feedback" })}>Give feedback</button>{g.plan && <button data-goal-action="edit" className="btn btn-ghost" onClick={() => setSheet({ goal: g, mode: "edit" })}>Edit plan</button>}</>}
      {!["completed", "cancelled"].includes(g.status) && <button className="btn btn-ghost" onClick={() => setSheet({ goal: g, mode: "cancel" })}>Cancel goal</button>}
    </div>
    <section className="card card-pad goal-overview"><h2 className="card-title">Desired outcome</h2><p className="goal-prose">{g.outcome}</p>
      {g.approvedAt ? <p className="muted">{tasks.filter((t) => t.status === "merged").length} of {g.tasks.length} tasks merged · {g.autoMerge ? "Automatic merging approved" : "Review each task before merge"}</p>
        : <p className="muted">{g.status === "researching" ? "The research agent is reviewing the repository. Implementation has not started." : "Review the scope, ordering and agent choices. Give feedback as often as needed before approval."}</p>}
      {research && <Link to={`/tasks/${research.id}`}>Open research · {STATUS_LABEL[research.status]}</Link>}
    </section>
    {g.plan && <>
      <section className="goal-section"><h2 className="card-title">The plan</h2><p className="goal-prose">{g.plan.summary}</p><details><summary>Approach and repository evidence</summary><p className="goal-prose">{g.plan.approach}</p></details></section>
      <p className="muted">Tasks in each group can run together, up to your active crew capacity. Each task starts as soon as its own dependencies have merged.</p>
      {goalWaves(g.plan).map((wave, i) => <section className="goal-section" key={i}><h2 className="card-title">{i === 0 ? "Start together" : `Then · group ${i + 1}`}</h2><div className="goal-task-grid">{wave.map((item) => {
        const link = g.tasks.find((t) => t.key === item.key);
        const task = tasks.find((t) => t.id === link?.taskId);
        return <article className="card card-pad goal-task" key={item.key}>
          <h3 className="card-title">{task ? <Link to={`/tasks/${task.id}`}>{item.title}</Link> : item.title}</h3>
          <p className="muted">{driverLabel(task?.driver ?? item.driver)} · {task ? task.model ?? "Default model" : item.model ?? "Default model"}{(task ? task.effort : item.effort) ? ` · ${task ? task.effort : item.effort} effort` : ""}</p>
          {task && <p><strong>{STATUS_LABEL[task.status]}</strong>{task.status === "queued" && item.dependsOn.length > 0 ? " · waits for dependencies to merge" : ""}</p>}
          <p className="muted">{item.dependsOn.length ? `After: ${item.dependsOn.map((key) => g.plan!.tasks.find((t) => t.key === key)?.title).join(", ")}` : "No dependencies"}</p>
          <details><summary>Brief and acceptance</summary><p className="goal-prose">{item.brief}</p><ul>{item.acceptance.map((c) => <li key={c}>{c}</li>)}{item.acceptanceChecks?.map((c) => <li key={c}>Check must pass: <span className="mono">{c}</span></li>)}</ul><p className="muted goal-prose">{item.rationale}</p></details>
          {task && ["failed", "cancelled", "rejected"].includes(task.status) && ["active", "blocked"].includes(g.status) && <div className="goal-actions"><button className="btn btn-sm" disabled={retrying} onClick={() => void retry(task.id)}>Retry task</button>{drivers?.filter((d) => d.available && d.name !== task.driver).map((d) => <button className="btn btn-sm btn-ghost" key={d.name} disabled={retrying} onClick={() => void retry(task.id, d.name)}>Retry on {d.label}</button>)}</div>}
        </article>;
      })}</div></section>)}
      {g.plan.improvements.length > 0 && <details className="goal-section"><summary>Optional improvements · {g.plan.improvements.length}</summary><ul>{g.plan.improvements.map((s) => <li key={s} className="goal-prose">{s}</li>)}</ul><p className="muted">These suggestions are outside the approved task scope unless included in a task.</p></details>}
    </>}
    {g.feedback.length > 0 && <details className="goal-section"><summary>Feedback history · {g.feedback.length}</summary>{g.feedback.map((f) => <div className="goal-feedback" key={f.revision}><p className="goal-prose">{f.text}</p><Link to={`/tasks/${f.taskId}`}>Research revision {f.revision}</Link></div>)}</details>}
    {sheet && (sheet.mode === "edit" ? <PlanEditor goal={sheet.goal} onClose={() => setSheet(null)} onSaved={refresh} /> : <GoalDecision goal={sheet.goal} mode={sheet.mode} onClose={() => setSheet(null)} onSaved={refresh} />)}
  </>;
}
