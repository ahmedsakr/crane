import { errorMessage } from "@crane/contracts";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../lib/app-context";
import {
  api,
  AUTONOMY_LABEL,
  driverLabel,
  MAINTENANCE_ROLE,
  MAINTENANCE_ROLES,
  type Agent,
  type DriverInfo,
  type MaintenanceRole,
  type MaintenanceRoleInfo,
  type TaskSummary,
} from "../lib/api";
import type { CrewSchedule } from "@crane/contracts";
import { ago } from "../lib/format";
import { parseStartTime } from "../lib/schedule";
import { Chevron, useToast } from "./bits";
import { ScheduleForm, ScheduleList } from "./CrewSchedules";
import { ScheduleFields } from "./ScheduleFields";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "./Sheet";

export type CrewInput = { active?: boolean; defaultDriver?: string | null; role?: MaintenanceRole | null };

/** One member as the page shows it: what they're on, and what's waiting for them. */
export interface Member {
  a: Agent;
  role: MaintenanceRoleInfo | null;
  /** The task they're working right now. */
  doing: TaskSummary | null;
  /** A run started for this member that they haven't picked up yet. */
  waiting: TaskSummary | null;
}

/** The short line under a member's name: their state, in the operator's words. */
export function memberStatus({ a, role, doing, waiting }: Member): string {
  const own = a.defaultDriver ? ` · ${driverLabel(a.defaultDriver)}` : "";
  const postmortems = a.runsPostmortems ? " · Runs post-mortems" : "";
  if (a.state === "working") {
    if (a.active) return `Working on ${driverLabel(a.driver)}`;
    return doing?.postmortemOf ? `Called in for a post-mortem on ${driverLabel(a.driver)}` : "Finishing current work, then on-call";
  }
  if (!a.active) return `On-call${postmortems}${role ? ` · ${role.label}` : ""}${own}`;
  if (a.state === "paused") return "Paused";
  if (role) return `${role.label}${waiting ? " · run queued" : ""}${postmortems}${own}`;
  return `Free${postmortems}${own}`;
}

export function Avatar({ a }: { a: Agent }) {
  return <span className={`avatar ${a.state === "working" ? "working" : ""}`} aria-hidden>{a.name[0]}</span>;
}

type View = { kind: "settings" } | { kind: "run" } | { kind: "schedule"; schedule: CrewSchedule | null };

/** Start a maintenance run, now or later, on the repo it should look at. */
function RunView({ member, role, onBack, onLeave }: {
  member: Agent;
  role: MaintenanceRoleInfo;
  /** Shown as a back button when another view opened this one. */
  onBack: (() => void) | undefined;
  /** Where Cancel and a started run go: back to the member, or out if the row opened this. */
  onLeave: () => void;
}) {
  const { overview, refresh } = useApp();
  const toast = useToast();
  const formId = useId();
  const repos = overview?.repos ?? [];
  const [repoId, setRepoId] = useState(() => repos.find((r) => r.isFactory)?.id ?? repos[0]?.id ?? "");
  const [start, setStart] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = overview?.inFlight.find((t) => t.repoId === repoId && t.assignee === member.id && ["queued", "running"].includes(t.status));
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const task = await api.runRole(member.id, { repoId: repoId || undefined, scheduledAt: parseStartTime(start) });
      toast({ text: `${task.scheduledAt ? "Scheduled" : "Queued"}: ${task.title}`, link: { to: `/tasks/${task.id}`, label: "Open" } });
      refresh();
      onLeave();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SheetHead onBack={onBack} title={role.action} subtitle={`${member.name} · ${AUTONOMY_LABEL[role.autonomy]}`} />
      <SheetBody>
        <form id={formId} className="run-form" aria-label={`Maintenance run for ${member.name}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="muted crew-note">{role.summary}</p>
          {repos.length > 1 && (
            <label className="tuning-field">
              <span>Repository</span>
              <select className="input" aria-label={`Run repository for ${member.name}`} value={repoId} disabled={saving}
                onChange={(e) => { setRepoId(e.target.value); setError(null); }}>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isFactory ? " (Crane itself)" : ""}</option>)}
              </select>
            </label>
          )}
          <ScheduleFields value={start} onChange={setStart} disabled={saving} />
          {pending && <p className="muted crew-note">{member.name} already has a run in this repo: <Link to={`/tasks/${pending.id}`}>{pending.title}</Link>. Choose another repo to start another run.</p>}
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onLeave}>Cancel</button>
        <button type="submit" form={formId} className="btn btn-primary btn-sm" disabled={saving || !!pending}>{start === null ? "Start run" : "Schedule run"}</button>
      </SheetFoot>
    </>
  );
}

function SettingsView({ m, drivers, factoryDriver, saving, configure, schedules, schedulesError, reloadSchedules, onRun, onSchedule }: {
  m: Member;
  drivers: DriverInfo[] | null;
  factoryDriver: string;
  saving: boolean;
  configure: (input: CrewInput) => void;
  schedules: CrewSchedule[] | null;
  schedulesError: string | null;
  reloadSchedules: () => Promise<void>;
  onRun: () => void;
  onSchedule: (schedule: CrewSchedule | null) => void;
}) {
  const { overview } = useApp();
  const { a, role, doing, waiting } = m;
  const pending = doing ?? waiting;
  const onCall = !a.active && a.state !== "working";
  const last = ago(a.lastActiveAt);
  return (
    <>
      <SheetHead leading={<Avatar a={a} />} title={a.name} subtitle={memberStatus(m)} />
      <SheetBody>
        {pending && (
          <section className="sheet-section">
            <h3 className="sheet-section-title">{doing ? "Working on" : "Up next"}</h3>
            <Link to={`/tasks/${pending.id}`} className="sheet-link">
              <span>{pending.title}</span>
              <Chevron />
            </Link>
          </section>
        )}
        <section className="sheet-section">
          <label className="tuning-field">
            <span className="sheet-section-title">Maintenance role</span>
            <select className="input" aria-label={`Maintenance role for ${a.name}`} value={a.role ?? ""} disabled={saving}
              onChange={(e) => configure({ role: (e.target.value || null) as MaintenanceRole | null })}>
              <option value="">None: takes any queued task</option>
              {MAINTENANCE_ROLES.map((r) => <option key={r} value={r}>{MAINTENANCE_ROLE[r].label}</option>)}
            </select>
            <span className="crew-field-note">
              {role
                ? `${role.summary} ${AUTONOMY_LABEL[role.autonomy]}. Works only the runs you start or schedule${a.runsPostmortems ? ", and post-mortems" : ""}.`
                : "Picks up the oldest queued task when free. Choose a role to start maintenance runs or set a schedule."}
            </span>
          </label>
        </section>
        {(role || !!schedules?.length) && (
          <section className="sheet-section">
            <div className="sheet-section-head">
              <h3 className="sheet-section-title">Runs</h3>
              {role && (
                <span className="sheet-section-actions">
                  {a.active && <button type="button" className="btn btn-quiet btn-sm" disabled={saving} onClick={onRun} aria-label={`Start maintenance run for ${a.name}`}>{role.action}</button>}
                  <button type="button" className="btn btn-quiet btn-sm" disabled={saving} onClick={() => onSchedule(null)}>Add schedule</button>
                </span>
              )}
            </div>
            <ScheduleList member={a} repos={overview?.repos ?? []} schedules={schedules} error={schedulesError} reload={reloadSchedules} onEdit={onSchedule} />
            {onCall && !!schedules?.length && <p className="muted crew-note">On-call members skip their scheduled runs. Activate {a.name} to run them.</p>}
            {!role && <p className="muted crew-note">These won't run until {a.name} has a maintenance role.</p>}
          </section>
        )}
        <section className="sheet-section">
          <label className="tuning-field">
            <span className="sheet-section-title">Default agent</span>
            <select className="input" aria-label={`Default agent for ${a.name}`} value={a.defaultDriver ?? ""} disabled={saving || !drivers}
              onChange={(e) => configure({ defaultDriver: e.target.value || null })}>
              <option value="">Factory default ({factoryDriver})</option>
              {drivers?.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>{d.label}{!d.available ? " (not installed)" : ""}</option>)}
            </select>
            <span className="crew-field-note">A task’s own agent choice and resumed sessions come first.</span>
          </label>
        </section>
      </SheetBody>
      <SheetFoot note={<><span className="tabular">{a.tasksCompleted}</span> finished{last ? ` · last active ${last}` : ""}</>}>
        <button type="button" className={`btn btn-sm ${onCall ? "btn-primary" : "btn-quiet"}`} disabled={saving} onClick={() => configure({ active: !a.active })}>
          {a.active ? "Put on-call" : "Activate"}
        </button>
      </SheetFoot>
    </>
  );
}

/** Everything about one crew member, one sheet: their work, role, runs, and schedules. */
export function MemberSheet({ m, start, drivers, factoryDriver, saving, configure, schedules, schedulesError, reloadSchedules, onClose }: {
  m: Member;
  /** Where it opens: the row's run button goes straight to the run form. */
  start: "settings" | "run";
  drivers: DriverInfo[] | null;
  factoryDriver: string;
  saving: boolean;
  configure: (input: CrewInput) => void;
  schedules: CrewSchedule[] | null;
  schedulesError: string | null;
  reloadSchedules: () => Promise<void>;
  onClose: () => void;
}) {
  const { overview } = useApp();
  const [view, setView] = useState<View>({ kind: start });
  const toSettings = () => setView({ kind: "settings" });
  // A role can go away while the sheet is open, from the CLI or another tab.
  const shown: View = view.kind === "run" && !(m.role && m.a.active) ? { kind: "settings" } : view;
  const fromRow = shown.kind === "run" && start === "run";
  const back = shown.kind === "settings" || fromRow ? undefined : toSettings;
  return (
    <Sheet onClose={onClose} onDismiss={back ?? onClose} view={shown.kind}>
      {shown.kind === "run" ? (
        <RunView member={m.a} role={m.role!} onBack={back} onLeave={back ?? onClose} />
      ) : shown.kind === "schedule" ? (
        <ScheduleForm member={m.a} repos={overview?.repos ?? []} schedule={shown.schedule} existing={schedules ?? []}
          reload={reloadSchedules} onDone={toSettings} onBack={toSettings} />
      ) : (
        <SettingsView m={m} drivers={drivers} factoryDriver={factoryDriver} saving={saving} configure={configure}
          schedules={schedules} schedulesError={schedulesError} reloadSchedules={reloadSchedules}
          onRun={() => setView({ kind: "run" })} onSchedule={(schedule) => setView({ kind: "schedule", schedule })} />
      )}
    </Sheet>
  );
}
