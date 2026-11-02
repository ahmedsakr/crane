import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/app-context";
import {
  api,
  driverLabel,
  MAINTENANCE_ROLE,
  settingsLabel,
  type Agent,
  type DriverInfo,
  type PostmortemSettings,
} from "../lib/api";
import type { CrewSchedule } from "@crane/contracts";
import { ago, plural } from "../lib/format";
import { useDrivers, usePoll, useTick } from "../lib/hooks";
import { nextSchedule, whenLabel } from "../lib/schedule";
import { Chevron, Empty, useToast } from "../components/bits";
import { Avatar, MemberSheet, memberStatus, type CrewInput, type Member } from "../components/MemberSheet";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../components/Sheet";

/** Choose the model and effort one agent runs with. */
function TuningSheet({ driver: d, onChange, onClose }: { driver: DriverInfo; onChange: (d: DriverInfo[]) => void; onClose: () => void }) {
  const toast = useToast();
  const formId = useId();
  const [model, setModel] = useState(d.model ?? "");
  const [effort, setEffort] = useState(d.effort ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.configureDriver(d.name, { model: model.trim() || null, effort: effort || null });
      onChange(next);
      const now = next.find((x) => x.name === d.name);
      toast({ text: `${d.label} runs on ${(now && settingsLabel(now)) ?? "its default model and effort"} from its next run` });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const listId = `models-${d.name}`;
  return (
    <Sheet onClose={onClose}>
      <SheetHead title={d.label} subtitle={d.hint} />
      <SheetBody>
        <form id={formId} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="tuning-field">
            <span>Model</span>
            <input className="input" list={listId} value={model} placeholder="Its default" disabled={saving}
              onChange={(e) => setModel(e.target.value)} aria-label={`${d.label} model`} />
            {d.models.length > 0 && (
              <datalist id={listId}>
                {d.models.map((m) => <option key={m} value={m} />)}
              </datalist>
            )}
          </label>
          <label className="tuning-field">
            <span>Effort</span>
            <select className="input" value={effort} disabled={saving} onChange={(e) => setEffort(e.target.value)} aria-label={`${d.label} effort`}>
              <option value="">Its default</option>
              {d.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving}>Save</button>
      </SheetFoot>
    </Sheet>
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
  const open = drivers.find((d) => d.name === editing);

  return (
    <section className="section crew-section" aria-labelledby="crew-runs-on">
      <div className="section-head">
        <h2 className="section-title" id="crew-runs-on">Runs on</h2>
        <span className="muted crew-section-note">Crew members use the default unless you choose an agent for them</span>
      </div>
      <ul className="rows card crew-list">
        {drivers.map((d) => {
          const tunable = d.available && d.efforts.length > 0;
          return (
            <li key={d.name}>
              <div className="crew-row crew-row-plain">
                <span className="crew-who">
                  {tunable ? (
                    <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label={`Change ${d.label} model and effort`} onClick={() => setEditing(d.name)}>{d.label}</button>
                  ) : (
                    <span className="agent-name" style={d.available ? undefined : { color: "var(--graphite)" }}>{d.label}</span>
                  )}
                  <span className="row-meta">{tunable ? settingsLabel(d) ?? "Default model and effort" : d.hint}</span>
                </span>
                <span className="crew-actions">
                  {d.isDefault ? <span className="chip chip-crane">default</span> : d.available && (
                    <button className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => void choose(d)}>Make default</button>
                  )}
                  {tunable && <Chevron />}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {open && <TuningSheet driver={open} onChange={onChange} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Independent defaults for the read-only review queued after a merge. */
function PostmortemDefaults({ drivers }: { drivers: DriverInfo[] }) {
  const toast = useToast();
  const formId = useId();
  const [saved, setSaved] = useState<PostmortemSettings | null>(null);
  const [draft, setDraft] = useState<PostmortemSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.postmortemSettings().then(setSaved).catch((e: Error) => setError(e.message));
  };
  useEffect(() => { load(); }, []);
  const selected = drivers.find((d) => d.name === draft?.driver);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await api.configurePostmortem(draft));
      setDraft(null);
      toast({ text: "Defaults saved for newly queued post-mortems" });
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <section className="section crew-section" aria-labelledby="crew-postmortems">
      <div className="section-head">
        <h2 className="section-title" id="crew-postmortems">Post-mortems</h2>
        <span className="muted crew-section-note">A read-only review of task friction, queued after each merge</span>
      </div>
      <div className="rows card crew-list">
        <div className="crew-row crew-row-plain">
          {error ? (
            <span role="alert">{error} <button className="tuning-change" onClick={load}>Retry</button></span>
          ) : !saved ? (
            <span className="muted">Loading defaults…</span>
          ) : (
            <>
              <span className="crew-who">
                <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label="Change post-mortem defaults"
                  onClick={() => { setSaveError(null); setDraft(saved); }}>
                  {saved.driver ? driverLabel(saved.driver) : "Merged task's agent"}
                </button>
                <span className="row-meta">{settingsLabel(saved) ?? "Agent settings"}</span>
              </span>
              <span className="crew-actions"><Chevron /></span>
            </>
          )}
        </div>
      </div>
      {draft && (
        <Sheet onClose={() => setDraft(null)}>
          <SheetHead title="Post-mortem defaults" subtitle="Applies when the next review is queued." />
          <SheetBody>
            <form id={formId} className="sheet-fields" aria-label="Post-mortem defaults" onSubmit={(e) => { e.preventDefault(); void save(); }}>
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
            </form>
          </SheetBody>
          <SheetFoot note={saveError ? <span className="error-text" role="alert">{saveError}</span> : undefined}>
            <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving}>Save</button>
          </SheetFoot>
        </Sheet>
      )}
    </section>
  );
}

/** Working members first, then those with a run waiting, then the free ones. */
const memberRank = (m: Member) => (m.doing ? 0 : m.waiting ? 1 : 2);

/** One crew member: who, what they're on, and the one action that matters now. Everything else is in their sheet. */
function MemberRow({ m, schedules, compact, saving, configure, onOpen, onRun }: {
  m: Member;
  schedules: CrewSchedule[];
  compact?: boolean;
  saving: boolean;
  configure: (input: CrewInput) => void;
  onOpen: () => void;
  onRun: () => void;
}) {
  const { a, role, doing, waiting } = m;
  const pending = doing ?? waiting;
  const onCall = !a.active && a.state !== "working";
  const next = nextSchedule(schedules);
  return (
    <li>
      <div className={`crew-row${compact ? " crew-row-compact" : ""}`}>
        <Avatar a={a} />
        <span className="crew-who">
          <span className="crew-name">
            <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label={`${a.name}: open details`} onClick={onOpen}>{a.name}</button>
            {a.state === "working" && <span className="dot dot-running" aria-label="Working" />}
          </span>
          <span className="row-meta">{memberStatus(m)}</span>
        </span>
        <span className="crew-what">
          {pending ? (
            <>
              <Link to={`/tasks/${pending.id}`} className="crew-task">{pending.title}</Link>
              <span className="row-meta">{doing ? `Started ${ago(doing.startedAt)}` : `Queued for ${a.name}`}</span>
            </>
          ) : !onCall && next ? (
            <span className="muted">Next run: {whenLabel(Date.parse(next.nextFireAt), { timeZone: next.timezone })}</span>
          ) : !onCall && schedules.length > 0 ? (
            <span className="muted">Schedules paused</span>
          ) : null}
        </span>
        <span className="crew-actions">
          {role && a.active && (
            <button className="btn btn-quiet btn-sm" title={role.summary} aria-label={`Start maintenance run for ${a.name}`} disabled={saving} onClick={onRun}>
              {role.action}
            </button>
          )}
          {onCall && (
            <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => configure({ active: true })}>
              Activate
            </button>
          )}
          <Chevron />
        </span>
      </div>
    </li>
  );
}

export function Crew() {
  const { overview: o, refresh } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ member: string; start: "settings" | "run" } | null>(null);
  const configure = async (a: Agent, input: CrewInput) => {
    setSaving(a.id);
    try {
      await api.configureCrew(a.id, input);
      if (input.active !== undefined) toast({ text: input.active ? `${a.name} is active` : a.state === "working" ? `${a.name} goes on-call after this task` : `${a.name} is on-call` });
      else if (input.role !== undefined) toast({ text: input.role ? `${a.name} now handles ${MAINTENANCE_ROLE[input.role].label.toLowerCase()}` : `${a.name} takes any queued task` });
      else if (input.defaultDriver !== undefined) toast({ text: input.defaultDriver ? `${a.name} runs on ${driverLabel(input.defaultDriver)}` : `${a.name} follows the factory default` });
      refresh();
    } catch (e) { toast({ text: (e as Error).message }); }
    finally { setSaving(null); }
  };
  const { drivers, set } = useDrivers();
  const schedules = usePoll(api.crewSchedules, 10_000);
  useTick();
  if (!o) return null;
  const driver = driverLabel(drivers?.find((d) => d.isDefault)?.name ?? o.factory.driver);
  const schedulesFor = (id: string) => schedules.data?.filter((s) => s.agentId === id) ?? [];

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
  const opened = sheet && members.find((m) => m.a.id === sheet.member);

  const row = (m: Member, compact?: boolean) => (
    <MemberRow key={m.a.id} m={m} compact={compact} schedules={schedulesFor(m.a.id)} saving={!!saving}
      configure={(input) => void configure(m.a, input)}
      onOpen={() => setSheet({ member: m.a.id, start: "settings" })}
      onRun={() => setSheet({ member: m.a.id, start: "run" })} />
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
          <button className="btn btn-primary btn-sm notice-action" disabled={!!saving} onClick={() => void configure(spare.a, { active: true })}>
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
              <ul className="rows card crew-list">{active.map((m) => row(m))}</ul>
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
              <ul className="rows card crew-list crew-bench">{onCall.map((m) => row(m, true))}</ul>
            </section>
          )}
        </>
      )}

      {drivers && drivers.length > 0 && <RunsOn drivers={drivers} onChange={set} />}
      {drivers && drivers.length > 0 && <PostmortemDefaults drivers={drivers} />}

      {opened && (
        <MemberSheet key={sheet.member} m={opened} start={sheet.start} drivers={drivers} factoryDriver={driver} saving={!!saving}
          configure={(input) => void configure(opened.a, input)}
          schedules={schedules.data ? schedulesFor(opened.a.id) : null} schedulesError={schedules.error} reloadSchedules={schedules.refresh}
          onClose={() => setSheet(null)} />
      )}
    </>
  );
}
