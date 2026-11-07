import { useId, useState } from "react";
import { errorMessage, MAINTENANCE_ROLE, type Agent, type CrewSchedule, type CrewScheduleInput, type Repo } from "@crane/contracts";
import { api } from "../lib/api";
import { isSignedOut } from "../lib/auth";
import {
  browserTimezone,
  DAY_PRESETS,
  daysLabel,
  newScheduleInput,
  schedulePreview,
  timeOfDayLabel,
  WEEK,
  whenLabel,
} from "../lib/schedule";
import { useToast } from "../lib/toast";
import { SheetBody, SheetFoot, SheetHead } from "./Sheet";

const canPreApprove = (member: Agent) => !!member.role && MAINTENANCE_ROLE[member.role].autonomy !== "observe";

/** Only what the API saves, leaving out next-fire and outcome fields. */
function toInput({ repoId, daysMask, localTime, timezone, preApprove, enabled }: CrewSchedule): CrewScheduleInput {
  return { repoId, daysMask, localTime, timezone, preApprove, enabled };
}

/** A member's schedules as they stand, each with its next run. Editing opens its own view. */
export function ScheduleList({ member, repos, schedules, error, reload, onEdit }: {
  member: Agent;
  repos: Repo[];
  schedules: CrewSchedule[] | null;
  error: string | null;
  reload: () => Promise<void>;
  onEdit: (schedule: CrewSchedule) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (s: CrewSchedule) => {
    setBusy(s.id);
    try {
      await api.saveCrewSchedule(member.id, { ...toInput(s), enabled: !s.enabled }, s.id);
      await reload();
    } catch (e) {
      if (!isSignedOut(e)) toast({ text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  if (error && !schedules) {
    return <p role="alert" className="crew-note">{error} <button type="button" className="tuning-change" onClick={() => void reload()}>Retry</button></p>;
  }
  if (!schedules) return <p className="muted crew-note">Loading schedules…</p>;
  if (schedules.length === 0) return <p className="muted crew-note">Nothing recurring yet.</p>;
  return (
    <ul className="schedule-list">
      {schedules.map((s) => {
        const tz = s.timezone === browserTimezone() ? "" : ` ${s.timezone}`;
        return (
          <li key={s.id} className="schedule-item">
            <div className="schedule-item-main">
              <strong>{daysLabel(s.daysMask)} at {timeOfDayLabel(s.localTime)}{tz}</strong>
              <span className="muted">
                {repos.find((r) => r.id === s.repoId)?.name ?? s.repoId}
                {" · "}{s.enabled ? `Next run: ${whenLabel(Date.parse(s.nextFireAt), { timeZone: s.timezone })}` : "Paused"}
                {" · "}{s.preApprove ? "Pre-approved" : "Waits for review"}
              </span>
              {s.preApprove && !canPreApprove(member) && <span className="error-text">This run gets skipped: investigate-only roles can't be pre-approved. Edit it to turn pre-approval off.</span>}
              {s.lastOutcome && <span className="muted">Last: {s.lastOutcome}</span>}
            </div>
            <div className="schedule-item-actions">
              <button type="button" className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => onEdit(s)} aria-label={`Edit ${daysLabel(s.daysMask)} schedule`}>Edit</button>
              <button type="button" className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => void toggle(s)}>{s.enabled ? "Pause" : "Resume"}</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

let timezones: string[] | null = null;
const allTimezones = () => (timezones ??= Intl.supportedValuesOf("timeZone"));

/** A form field's view of the draft: what it holds, and how to change part of it. */
type DraftField = { draft: CrewScheduleInput; change: (patch: Partial<CrewScheduleInput>) => void };

function RepoField({ repos, draft, change }: DraftField & { repos: Repo[] }) {
  return (
    <label className="tuning-field">
      <span>Repository</span>
      <select className="input" value={draft.repoId} required onChange={(e) => change({ repoId: e.target.value })}>
        {!draft.repoId && <option value="">Choose a repo</option>}
        {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
  );
}

function RepeatsField({ draft, change }: DraftField) {
  const labelId = useId();
  return (
    <div className="tuning-field">
      <span id={labelId}>Repeats</span>
      <div className="pills" role="group" aria-labelledby={labelId}>
        {DAY_PRESETS.map((p) => (
          <button type="button" key={p.mask} className={`pill-btn${draft.daysMask === p.mask ? " on" : ""}`} aria-pressed={draft.daysMask === p.mask}
            onClick={() => change({ daysMask: p.mask })}>{p.label}</button>
        ))}
      </div>
      <div className="week" role="group" aria-label="Days of the week">
        {WEEK.map((d) => (
          <label className="pill week-day" key={d.bit}>
            <input type="checkbox" checked={!!(draft.daysMask & (1 << d.bit))} onChange={() => change({ daysMask: draft.daysMask ^ (1 << d.bit) })} />
            <span>{d.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** The timezone reads as a sentence until someone asks to change it. */
function TimezoneField({ draft, change }: DraftField) {
  const listId = useId();
  const [changing, setChanging] = useState(() => draft.timezone !== browserTimezone());
  if (!changing) {
    return <p className="muted crew-note">In {draft.timezone}. <button type="button" className="tuning-change" onClick={() => setChanging(true)} aria-label="Change timezone">Change</button></p>;
  }
  return (
    <label className="tuning-field">
      <span>Timezone</span>
      <input className="input" required list={listId} value={draft.timezone} placeholder={browserTimezone()}
        onChange={(e) => change({ timezone: e.target.value })} />
      <datalist id={listId}>{allTimezones().map((z) => <option key={z} value={z} />)}</datalist>
    </label>
  );
}

function PreApproveField({ draft, change }: DraftField) {
  return (
    <label className="check">
      <input type="checkbox" checked={draft.preApprove} onChange={(e) => change({ preApprove: e.target.checked })} />
      <span>
        Pre-approve each run
        <small>Runs merge after their checks pass. This also waives visual review for each run, including conflict resolutions. Without this, each one waits for your review.</small>
      </span>
    </label>
  );
}

function ScheduleFormFields({ member, repos, draft, change, preview, busy }: DraftField & {
  member: Agent;
  repos: Repo[];
  preview: ReturnType<typeof schedulePreview>;
  busy: boolean;
}) {
  return (
    <fieldset disabled={busy} className="schedule-fields">
      {repos.length > 1 && <RepoField repos={repos} draft={draft} change={change} />}
      <RepeatsField draft={draft} change={change} />
      <label className="tuning-field schedule-time">
        <span>Time</span>
        <input type="time" className="input" required value={draft.localTime} onChange={(e) => change({ localTime: e.target.value })} />
      </label>
      <TimezoneField draft={draft} change={change} />
      {(canPreApprove(member) || draft.preApprove) && <PreApproveField draft={draft} change={change} />}
      {"next" in preview ? (
        <p className="when-summary"><span className="muted">Next run:</span> <strong>{preview.next}</strong></p>
      ) : (
        <p className="when-summary error-text" role="alert">{preview.problem}</p>
      )}
      <details className="gates schedule-rules">
        <summary>When a slot gets skipped</summary>
        <p className="muted">Missed slots catch up once. A slot is skipped while this member is on-call, the factory is paused, or their last run is still open. Spring clock gaps skip that day; repeated times run once at the earlier instant.</p>
      </details>
    </fieldset>
  );
}

function ScheduleFoot({ formId, canRemove, canSave, busy, error, onCancel, onRemove }: {
  formId: string;
  canRemove: boolean;
  canSave: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const errorNote = error ? <span className="error-text" role="alert">{error}</span> : null;
  if (removing) {
    return (
      <SheetFoot note={errorNote ?? "Remove this schedule?"}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoving(false)}>Keep</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onRemove}>Remove</button>
      </SheetFoot>
    );
  }
  const removeButton = canRemove ? <button type="button" className="btn btn-ghost btn-sm schedule-remove" disabled={busy} onClick={() => setRemoving(true)}>Remove</button> : undefined;
  return (
    <SheetFoot note={errorNote ?? removeButton}>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" form={formId} className="btn btn-primary btn-sm" disabled={busy || !canSave}>Save schedule</button>
    </SheetFoot>
  );
}

/** Add or change a recurring run. Starts ready to save, and previews the next run as it changes. */
export function ScheduleForm({ member, repos, schedule, existing, reload, onDone, onBack }: {
  member: Agent;
  repos: Repo[];
  schedule: CrewSchedule | null;
  existing: CrewSchedule[];
  reload: () => Promise<void>;
  onDone: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const formId = useId();
  const [draft, setDraft] = useState<CrewScheduleInput>(() => (schedule ? toInput(schedule) : newScheduleInput(repos, existing)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<CrewScheduleInput>) => setDraft({ ...draft, ...patch });
  const preview = schedulePreview(draft);
  const role = member.role ? MAINTENANCE_ROLE[member.role] : null;
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      toast({ text: await fn() });
      await reload();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(async () => {
    const saved = await api.saveCrewSchedule(member.id, draft, schedule?.id);
    return saved.enabled ? `Schedule saved. Next run: ${whenLabel(Date.parse(saved.nextFireAt), { timeZone: saved.timezone })}` : "Schedule saved";
  });
  const remove = () => act(async () => {
    await api.removeCrewSchedule(member.id, schedule!.id);
    return "Schedule removed";
  });

  return (
    <>
      <SheetHead onBack={onBack} title={schedule ? "Edit schedule" : "New schedule"} subtitle={`${member.name}${role ? ` · ${role.label}` : ""}`} />
      <SheetBody>
        <form id={formId} onSubmit={(e) => { e.preventDefault(); if ("next" in preview) void save(); }}>
          <ScheduleFormFields member={member} repos={repos} draft={draft} change={change} preview={preview} busy={busy} />
        </form>
      </SheetBody>
      <ScheduleFoot formId={formId} canRemove={!!schedule} canSave={"next" in preview} busy={busy} error={error}
        onCancel={onBack} onRemove={() => void remove()} />
    </>
  );
}
