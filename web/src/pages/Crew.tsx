import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/app-context";
import {
  api,
  AUTONOMY_LABEL,
  driverLabel,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  settingsLabel,
  type Agent,
  type DriverInfo,
  type MaintenanceRole,
  type MaintenanceRoleInfo,
  type PostmortemSettings,
  type Task,
} from "../lib/api";
import { ago, plural } from "../lib/format";
import { useDrivers, useTick } from "../lib/hooks";
import { Chevron, Empty, useToast } from "../components/bits";

/** What an agent runs on, with the editor one tap away. */
function TuningSummary({ driver: d, onEdit }: { driver: DriverInfo; onEdit: () => void }) {
  const label = settingsLabel(d);
  return (
    <span className="row-meta" style={{ display: "block", whiteSpace: "normal", marginTop: 4 }}>
      <span style={{ color: label ? "var(--ink)" : undefined }}>{label ?? "Default model and effort"}</span>
{" "}
      <span style={{ whiteSpace: "nowrap" }}>
        ·{" "}
        <button className="tuning-change" onClick={onEdit} aria-label={`Change ${d.label} model and effort`}>
          Change
        </button>
      </span>
    </span>
  );
}

/** Choose the model and effort one agent runs with. */
function TuningForm({ driver: d, onChange, onClose }: { driver: DriverInfo; onChange: (d: DriverInfo[]) => void; onClose: () => void }) {
  const toast = useToast();
  const [model, setModel] = useState(d.model ?? "");
  const [effort, setEffort] = useState(d.effort ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const next = await api.configureDriver(d.name, { model: model.trim() || null, effort: effort || null });
      onChange(next);
      const now = next.find((x) => x.name === d.name);
      toast({ text: `${d.label} runs on ${(now && settingsLabel(now)) ?? "its default model and effort"} from its next run` });
      onClose();
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const listId = `models-${d.name}`;
  return (
    <form
      className="tuning"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="tuning-field">
        <span>Model</span>
        <input className="input" list={listId} value={model} placeholder="Its default" autoFocus
          onChange={(e) => setModel(e.target.value)} aria-label={`${d.label} model`} />
        {d.models.length > 0 && (
          <datalist id={listId}>
            {d.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        )}
      </label>
      <label className="tuning-field">
        <span>Effort</span>
        <select className="input" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label={`${d.label} effort`}>
          <option value="">Its default</option>
          {d.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <span className="tuning-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>Save</button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
      </span>
    </form>
  );
}

/** The agents the crew can run on. The default is what new tasks use unless the operator picks another. */
function RunsOn({ drivers, onChange }: { drivers: DriverInfo[]; onChange: (d: DriverInfo[]) => void }) {
  const toast = useToast();
  const { refresh } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const choose = async (d: DriverInfo) => {
    setBusy(d.name);
    try {
      onChange(await api.setDefaultDriver(d.name));
      toast({ text: `Factory default set to ${d.label}` });
      refresh();
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Runs on</h2>
      </div>
      <p className="muted" style={{ maxWidth: "60ch", margin: "0 0 12px", fontSize: 14 }}>
        Crew members use the default unless you choose an agent for them. Each agent runs on the model and effort you set here.
        {drivers.some((d) => d.isDefault && d.name === "simulated") && " Simulated agents don't call a model; they're for trying Crane out."}
      </p>
      <ul className="rows card" style={{ padding: "0 18px" }}>
        {drivers.map((d) => (
          <li key={d.name}>
            <div className="row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <span style={{ minWidth: 0 }}>
                <span className="row-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: d.available ? undefined : "var(--graphite)" }}>{d.label}</span>
                  {d.isDefault && <span className="chip chip-crane">default</span>}
                </span>
                <span className="row-meta" style={{ display: "block", whiteSpace: "normal" }}>
                  {d.hint}
                </span>
                {d.available && d.efforts.length > 0 && editing !== d.name && (
                  <TuningSummary driver={d} onEdit={() => setEditing(d.name)} />
                )}
              </span>
              <span>
                {d.isDefault ? null : d.available ? (
                  <button className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => choose(d)}>
                    Make default
                  </button>
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Not installed
                  </span>
                )}
              </span>
              {editing === d.name && (
                <div style={{ gridColumn: "1 / -1", marginTop: -6 }}>
                  <TuningForm driver={d} onChange={onChange} onClose={() => setEditing(null)} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Independent defaults for the read-only review queued after a merge. */
function PostmortemDefaults({ drivers }: { drivers: DriverInfo[] }) {
  const toast = useToast();
  const [saved, setSaved] = useState<PostmortemSettings | null>(null);
  const [draft, setDraft] = useState<PostmortemSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.postmortemSettings().then(setSaved).catch((e: Error) => setError(e.message));
  };
  useEffect(() => { load(); }, []);
  const selected = drivers.find((d) => d.name === draft?.driver);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      setSaved(await api.configurePostmortem(draft));
      setDraft(null);
      toast({ text: "Defaults saved for newly queued post-mortems" });
    } catch (e) { toast({ text: (e as Error).message }); }
    finally { setSaving(false); }
  };
  return (
    <section className="section">
      <div className="section-head"><h2 className="section-title">Post-mortems</h2></div>
      <p className="muted" style={{ maxWidth: "60ch", margin: "0 0 12px", fontSize: 14 }}>
        After each merge, Crane queues a read-only review of task friction. These defaults apply when that review is queued.
      </p>
      <div className="card" style={{ padding: 18 }}>
        {error ? <span role="alert">{error} <button className="tuning-change" onClick={load}>Retry</button></span> : !saved ? (
          <span className="muted">Loading defaults…</span>
        ) : draft ? (
          <form className="tuning" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Post-mortem defaults">
            <label className="tuning-field">
              <span>Agent</span>
              <select className="input" aria-label="Post-mortem agent" value={draft.driver ?? ""} disabled={saving}
                onChange={(e) => setDraft({ driver: (e.target.value || null) as PostmortemSettings["driver"], model: null, effort: null })}>
                <option value="">Merged task's agent</option>
                {drivers.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>{d.label}{!d.available ? " (not installed)" : ""}</option>)}
              </select>
            </label>
            {!!selected?.efforts.length && <>
              <label className="tuning-field">
                <span>Model</span>
                <input className="input" aria-label="Post-mortem model" list="postmortem-models" value={draft.model ?? ""}
                  placeholder="Agent setting" disabled={saving} onChange={(e) => setDraft({ ...draft, model: e.target.value || null })} />
                <datalist id="postmortem-models">{selected.models.map((m) => <option key={m} value={m} />)}</datalist>
              </label>
              <label className="tuning-field">
                <span>Effort</span>
                <select className="input" aria-label="Post-mortem effort" value={draft.effort ?? ""} disabled={saving}
                  onChange={(e) => setDraft({ ...draft, effort: e.target.value || null })}>
                  <option value="">Agent setting</option>
                  {selected.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select>
              </label>
            </>}
            <span className="tuning-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>Save</button>
              <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
            </span>
          </form>
        ) : <>
          <span className="row-title">{saved.driver ? driverLabel(saved.driver) : "Merged task's agent"}</span>
          <span className="row-meta" style={{ display: "block", whiteSpace: "normal", marginTop: 4 }}>
            {settingsLabel(saved) ?? "Agent settings"} · <button className="tuning-change" aria-label="Change post-mortem defaults" onClick={() => setDraft(saved)}>Change</button>
          </span>
        </>}
      </div>
    </section>
  );
}

type CrewInput = { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null };

/** One member as the page shows it: what they're on, and what's waiting for them. */
interface Member {
  a: Agent;
  role: MaintenanceRoleInfo | null;
  /** The task they're working right now. */
  doing: Task | null;
  /** A run started for this member that they haven't picked up yet. */
  waiting: Task | null;
}

/** Working members first, then those with a run waiting, then the free ones. */
const memberRank = (m: Member) => (m.doing ? 0 : m.waiting ? 1 : 2);

/** The short line under a member's name: their state, in the operator's words. */
function memberStatus({ a, role, waiting }: Member): string {
  const own = a.defaultDriver ? ` · ${driverLabel(a.defaultDriver)}` : "";
  if (a.state === "working") return a.active ? `Working on ${driverLabel(a.driver)}` : "Finishing current work, then on-call";
  if (!a.active) return `On-call${role ? ` · ${role.label}` : ""}${own}`;
  if (a.state === "paused") return "Paused";
  // The run button already says what an idle maintainer is waiting for.
  if (role) return `${role.label}${waiting ? " · run queued" : ""}${own}`;
  return `Waiting for work${own}`;
}

/** A member's maintenance role, default agent, and on-call switch, opened from their row. */
function MemberSettings({
  m,
  drivers,
  factoryDriver,
  saving,
  configure,
}: {
  m: Member;
  drivers: DriverInfo[] | null;
  factoryDriver: string;
  saving: boolean;
  configure: (input: CrewInput) => void;
}) {
  const { a, role } = m;
  // On-call members who aren't working already have Activate on their row.
  const toggle = a.active || a.state === "working";
  const last = ago(a.lastActiveAt);
  return (
    <div className="crew-settings" id={`crew-settings-${a.id}`}>
      <div className="crew-fields">
        <label className="tuning-field">
          <span>Maintenance role</span>
          <select className="input" aria-label={`Maintenance role for ${a.name}`} value={a.role ?? ""} disabled={saving}
            onChange={(e) => configure({ role: (e.target.value || null) as MaintenanceRole | null })}>
            <option value="">None: takes any queued task</option>
            {MAINTENANCE_ROLES.map((r) => <option key={r} value={r}>{MAINTENANCE_ROLE[r].label}</option>)}
          </select>
          <span className="crew-field-note">
            {role ? `${role.summary} ${AUTONOMY_LABEL[role.autonomy]}. Works only the runs you start.` : "Picks up the oldest queued task when free."}
          </span>
        </label>
        <label className="tuning-field">
          <span>Default agent</span>
          <select className="input" aria-label={`Default agent for ${a.name}`} value={a.defaultDriver ?? ""} disabled={saving || !drivers}
            onChange={(e) => configure({ defaultDriver: e.target.value || null })}>
            <option value="">Factory default ({factoryDriver})</option>
            {drivers?.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>{d.label}{!d.available ? " (not installed)" : ""}</option>)}
          </select>
          <span className="crew-field-note">A task’s own agent choice and resumed sessions come first.</span>
        </label>
      </div>
      <div className="crew-settings-foot">
        <span className="muted">
          <span className="tabular">{a.tasksCompleted}</span> finished{last ? ` · last active ${last}` : ""}
        </span>
        {toggle && (
          <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => configure({ active: !a.active })}>
            {a.active ? "Put on-call" : "Activate"}
          </button>
        )}
      </div>
    </div>
  );
}

/** One crew member: who, what they're on, and the one action that matters now. Settings open in place. */
function MemberRow({
  m,
  open,
  onToggle,
  saving,
  configure,
  run,
  children,
}: {
  m: Member;
  open: boolean;
  onToggle: () => void;
  saving: boolean;
  configure: (input: CrewInput) => void;
  run: () => void;
  children: ReactNode;
}) {
  const { a, role, doing, waiting } = m;
  const pending = doing ?? waiting;
  const onCall = !a.active && a.state !== "working";
  return (
    <li>
      <div className={`crew-row${open ? " open" : ""}`}>
        <span className={`avatar ${a.state === "working" ? "working" : ""}`}>{a.name[0]}</span>
        <span className="crew-who">
          <span className="agent-name crew-name">
            {a.name}
            {a.state === "working" && <span className="dot dot-running" aria-label="Working" />}
          </span>
          <span className="row-meta">{memberStatus(m)}</span>
        </span>
        <span className="crew-what">
          {pending ? (
            <>
              <Link to={`/tasks/${pending.id}`} className="crew-task">{pending.title}</Link>
              {!doing && <span className="muted"> · queued for {a.name}</span>}
            </>
          ) : a.active && a.state !== "paused" && !role ? (
            <span className="muted">Nothing assigned</span>
          ) : null}
        </span>
        <span className="crew-actions">
          {/* Hidden while their own run is queued or underway: the row already shows it. */}
          {role && a.active && pending?.assignee !== a.id && (
            <button className="btn btn-quiet btn-sm" title={role.summary} disabled={saving} onClick={run}>
              {role.action}
            </button>
          )}
          {onCall && (
            <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => configure({ active: true })}>
              Activate
            </button>
          )}
          <button className="crew-toggle" onClick={onToggle} aria-expanded={open} aria-controls={`crew-settings-${a.id}`}
            aria-label={`${open ? "Hide" : "Show"} settings for ${a.name}`} title="Role, agent, and on-call">
            <Chevron />
          </button>
        </span>
      </div>
      {open && children}
    </li>
  );
}

export function Crew() {
  const { overview: o, refresh } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const configure = async (a: Agent, input: CrewInput) => {
    setSaving(a.id);
    try {
      await api.configureCrew(a.id, input);
      if (input.active !== undefined) toast({ text: input.active ? `${a.name} is active` : a.state === "working" ? `${a.name} goes on-call after this task` : `${a.name} is on-call` });
      refresh();
    } catch (e) { toast({ text: (e as Error).message }); }
    finally { setSaving(null); }
  };
  const run = async (id: string) => {
    setSaving(id);
    try {
      const t = await api.runRole(id);
      toast({ text: `Queued: ${t.title}`, link: { to: `/tasks/${t.id}`, label: "Open" } });
      refresh();
    } catch (e) { toast({ text: (e as Error).message }); }
    finally { setSaving(null); }
  };
  const { drivers, set } = useDrivers();
  useTick();
  if (!o) return null;
  const driver = driverLabel(drivers?.find((d) => d.isDefault)?.name ?? o.factory.driver);

  const members: Member[] = o.agents.map((a) => {
    const doing = a.taskId ? o.inFlight.find((m) => m.id === a.taskId) ?? null : null;
    const waiting = doing ? null : o.inFlight.find((m) => m.assignee === a.id && m.status === "queued") ?? null;
    return { a, role: a.role ? MAINTENANCE_ROLE[a.role] : null, doing, waiting };
  });
  // Members still finishing a task stay with the active ones until it's done.
  const active = members.filter((m) => m.a.active || m.a.state === "working").sort((x, y) => memberRank(x) - memberRank(y));
  const onCall = members.filter((m) => !m.a.active && m.a.state !== "working");
  const working = members.filter((m) => m.a.state === "working").length;
  const free = active.filter((m) => m.a.active && m.a.state === "idle" && !m.role && !m.waiting);

  // Queued work nobody is free to take: offer the one tap that fixes it.
  const queuedForAnyone = o.queuedForAnyone ?? 0;
  const spare = onCall.find((m) => !m.role);
  const short = o.factory.running && !o.factory.paused && queuedForAnyone > 0 && free.length === 0 && spare;

  const row = (m: Member) => (
    <MemberRow key={m.a.id} m={m} open={open === m.a.id} onToggle={() => setOpen(open === m.a.id ? null : m.a.id)}
      saving={!!saving} configure={(input) => configure(m.a, input)} run={() => run(m.a.id)}>
      <MemberSettings m={m} drivers={drivers} factoryDriver={driver} saving={!!saving} configure={(input) => configure(m.a, input)} />
    </MemberRow>
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Crew</h1>
      </div>
      {o.agents.length > 0 && (
        <p className="crew-summary">
          <span><strong className="tabular">{working}</strong> working</span>
          <span><strong className="tabular">{free.length}</strong> free</span>
          <span><strong className="tabular">{onCall.length}</strong> on-call</span>
          <span>New tasks run on <strong>{driver}</strong></span>
        </p>
      )}

      {!o.factory.running && (
        <div className="notice">
          <strong>The factory is off.</strong>
          <span>Run <span className="mono">crane serve</span> to bring the crew in.</span>
        </div>
      )}
      {short && (
        <div className="notice" role="status">
          <span>
            <strong>{plural(queuedForAnyone, "task")} waiting</strong> and no one is free to take {queuedForAnyone === 1 ? "it" : "them"}.
          </span>
          <button className="btn btn-primary btn-sm notice-action" disabled={!!saving} onClick={() => configure(spare.a, { active: true })}>
            Activate {spare.a.name}
          </button>
        </div>
      )}

      {o.agents.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title="No agents yet">
            Start the factory with <span className="mono">crane serve --agents 3</span>.
          </Empty>
        </div>
      ) : (
        <>
          <section className="section crew-section" aria-labelledby="crew-active">
            <div className="section-head">
              <h2 className="section-title" id="crew-active">
                Active <span className="count">{active.length}</span>
              </h2>
            </div>
            {active.length > 0 ? (
              <ul className="rows card crew-list">{active.map(row)}</ul>
            ) : (
              <Empty title="No one is active">Activate an on-call member to start taking work.</Empty>
            )}
          </section>

          {onCall.length > 0 && (
            <section className="section crew-section" aria-labelledby="crew-on-call">
              <div className="section-head">
                <h2 className="section-title" id="crew-on-call">
                  On-call <span className="count">{onCall.length}</span>
                </h2>
                <span className="muted crew-section-note">No new work until you activate them</span>
              </div>
              <ul className="rows card crew-list">{onCall.map(row)}</ul>
            </section>
          )}
        </>
      )}

      {drivers && drivers.length > 0 && <RunsOn drivers={drivers} onChange={set} />}
      {drivers && drivers.length > 0 && <PostmortemDefaults drivers={drivers} />}
    </>
  );
}
