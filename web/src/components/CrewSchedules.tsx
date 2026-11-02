import { useId, useState } from "react";
import { MAINTENANCE_ROLE, type Agent, type CrewSchedule, type CrewScheduleInput, type Repo } from "@crane/contracts";
import { api } from "../lib/api";
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
import { useToast } from "./bits";
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
      toast({ text: (e as Error).message });
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
  const [changingZone, setChangingZone] = useState(() => draft.timezone !== browserTimezone());
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError((e as Error).message);
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
          <fieldset disabled={busy} className="schedule-fields">
            {repos.length > 1 && (
              <label className="tuning-field">
                <span>Repository</span>
                <select className="input" value={draft.repoId} required onChange={(e) => setDraft({ ...draft, repoId: e.target.value })}>
                  {!draft.repoId && <option value="">Choose a repo</option>}
                  {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            )}
            <div className="tuning-field">
              <span id={`${formId}-days`}>Repeats</span>
              <div className="pills" role="group" aria-labelledby={`${formId}-days`}>
                {DAY_PRESETS.map((p) => (
                  <button type="button" key={p.mask} className={`pill-btn${draft.daysMask === p.mask ? " on" : ""}`} aria-pressed={draft.daysMask === p.mask}
                    onClick={() => setDraft({ ...draft, daysMask: p.mask })}>{p.label}</button>
                ))}
              </div>
              <div className="week" role="group" aria-label="Days of the week">
                {WEEK.map((d) => (
                  <label className="pill week-day" key={d.bit}>
                    <input type="checkbox" checked={!!(draft.daysMask & (1 << d.bit))} onChange={() => setDraft({ ...draft, daysMask: draft.daysMask ^ (1 << d.bit) })} />
                    <span>{d.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="tuning-field schedule-time">
              <span>Time</span>
              <input type="time" className="input" required value={draft.localTime} onChange={(e) => setDraft({ ...draft, localTime: e.target.value })} />
            </label>
            {changingZone ? (
              <label className="tuning-field">
                <span>Timezone</span>
                <input className="input" required list={`${formId}-zones`} value={draft.timezone} placeholder={browserTimezone()}
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
                <datalist id={`${formId}-zones`}>{allTimezones().map((z) => <option key={z} value={z} />)}</datalist>
              </label>
            ) : (
              <p className="muted crew-note">In {draft.timezone}. <button type="button" className="tuning-change" onClick={() => setChangingZone(true)} aria-label="Change timezone">Change</button></p>
            )}
            {(canPreApprove(member) || draft.preApprove) && (
              <label className="check">
                <input type="checkbox" checked={draft.preApprove} onChange={(e) => setDraft({ ...draft, preApprove: e.target.checked })} />
                <span>
                  Pre-approve each run
                  <small>Runs merge after their checks pass. Without this, each one waits for your review.</small>
                </span>
              </label>
            )}
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
        </form>
      </SheetBody>
      {removing ? (
        <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : "Remove this schedule?"}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoving(false)}>Keep</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void remove()}>Remove</button>
        </SheetFoot>
      ) : (
        <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : schedule ? (
          <button type="button" className="btn btn-ghost btn-sm schedule-remove" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>
        ) : undefined}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onBack}>Cancel</button>
          <button type="submit" form={formId} className="btn btn-primary btn-sm" disabled={busy || !("next" in preview)}>Save schedule</button>
        </SheetFoot>
      )}
    </>
  );
}
