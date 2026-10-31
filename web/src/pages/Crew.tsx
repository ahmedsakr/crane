import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../App";
import {
  api,
  AUTONOMY_LABEL,
  driverLabel,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  settingsLabel,
  type DriverInfo,
  type MaintenanceRole,
} from "../lib/api";
import { ago, plural } from "../lib/format";
import { useDrivers, useTick } from "../lib/hooks";
import { Empty, useToast } from "../components/bits";

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
        Crew members follow the factory default unless you choose an agent for them. A task’s agent choice and resumed sessions take priority. Each agent runs on the model and effort you set here.
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

export function Crew() {
  const { overview: o, refresh } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const configure = async (id: string, input: { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null }) => {
    setSaving(id);
    try { await api.configureCrew(id, input); refresh(); }
    catch (e) { toast({ text: (e as Error).message }); }
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

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Crew</h1>
      </div>
      <p className="muted" style={{ maxWidth: "60ch" }}>
        {o.factory.running
          ? `${plural(o.agents.filter((a) => a.active).length, "active crew member")}, with ${driver} as the factory default. Each picks up the oldest queued task when it's free.`
          : "The factory is off. Run crane serve to bring the crew in."}
        {" On-call members take no new work until you activate them. Members with a maintenance role work only the runs you start for them."}
        {o.factory.driver === "simulated" && " Simulated agents don't call a model; they're for trying Crane out."}
      </p>

      {o.agents.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title="No agents yet">
            Start the factory with <span className="mono">crane serve --agents 3</span>.
          </Empty>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
            gap: 16,
            marginTop: 20,
          }}
        >
          {o.agents.map((a) => {
            const doing = a.taskId ? o.inFlight.find((m) => m.id === a.taskId) : null;
            const role = a.role ? MAINTENANCE_ROLE[a.role] : null;
            // A run started for this member that it hasn't picked up yet.
            const waiting = !doing ? o.inFlight.find((m) => m.assignee === a.id && m.status === "queued") : null;
            const pending = doing ?? waiting;
            return (
              <div className="card card-pad" key={a.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span className={`avatar ${a.state === "working" ? "working" : ""}`} style={{ width: 44, height: 44, fontSize: 18 }}>
                    {a.name[0]}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="agent-name" style={{ display: "block", fontSize: 16 }}>
                      {a.name}
                    </span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {a.state === "working"
                        ? `Working on ${driverLabel(a.driver)}`
                        : !a.active
                          ? "On-call"
                          : a.state === "paused"
                          ? "Paused"
                          : role
                          ? `${role.label} · waiting for a run`
                          : "Waiting for work"}
                    </span>
                  </span>
                  {a.state === "working" && <span className="dot dot-running" style={{ marginLeft: "auto" }} />}
                </div>
                <div style={{ marginTop: 16, fontSize: 14, minHeight: 42 }}>
                  {pending ? (
                    <>
                      <Link to={`/tasks/${pending.id}`} style={{ fontWeight: 600 }}>
                        {pending.title}
                      </Link>
                      {!doing && <span className="muted" style={{ display: "block", fontSize: 13 }}>Queued for {a.name}</span>}
                    </>
                  ) : (
                    <span className="muted">Nothing assigned</span>
                  )}
                </div>
                {role && a.active && (
                  <button className="btn btn-primary btn-sm" style={{ width: "100%", marginTop: 12 }}
                    disabled={!!saving || (!!pending && pending.assignee === a.id)}
                    title={role.summary}
                    onClick={() => run(a.id)}>
                    {role.action}
                  </button>
                )}
                <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                  <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                    Maintenance role
                    <select style={{ minWidth: 0, width: "100%" }} aria-label={`Maintenance role for ${a.name}`} value={a.role ?? ""} disabled={!!saving}
                      onChange={(e) => configure(a.id, { role: (e.target.value || null) as MaintenanceRole | null })}>
                      <option value="">None: takes any queued task</option>
                      {MAINTENANCE_ROLES.map((r) => <option key={r} value={r}>{MAINTENANCE_ROLE[r].label}</option>)}
                    </select>
                    {role && <span className="muted">{role.summary} {AUTONOMY_LABEL[role.autonomy]}.</span>}
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                    Default agent
                    <select style={{ minWidth: 0, width: "100%" }} aria-label={`Default agent for ${a.name}`} value={a.defaultDriver ?? ""} disabled={!!saving || !drivers}
                      onChange={(e) => configure(a.id, { defaultDriver: e.target.value || null })}>
                      <option value="">Factory default ({driver})</option>
                      {drivers?.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>{d.label}{!d.available ? " (not installed)" : ""}</option>)}
                    </select>
                  </label>
                  <button className="btn btn-quiet btn-sm" disabled={!!saving}
                    onClick={() => configure(a.id, { active: !a.active })}>
                    {a.active ? "Put on-call" : "Activate"}
                  </button>
                  {!a.active && a.state === "working" && <span className="muted" style={{ fontSize: 13 }}>Finishing current work, then on-call</span>}
                </div>
                <dl className="facts" style={{ marginTop: 12, borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
                  <dt>Finished</dt>
                  <dd className="tabular">{a.tasksCompleted}</dd>
                  <dt>Last active</dt>
                  <dd>{ago(a.lastActiveAt) || "—"}</dd>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {drivers && drivers.length > 0 && <RunsOn drivers={drivers} onChange={set} />}
    </>
  );
}
