import { useEffect, useState } from "react";
import { crewScheduleLabel, MAINTENANCE_ROLE, type Agent, type CrewSchedule, type CrewScheduleInput, type Repo } from "@crane/contracts";
import { api } from "../lib/api";
import { useToast } from "./bits";

/** Schedule summary stays on the member row; configuration is one tap away. */
export function CrewSchedules({ member, repos }: { member: Agent; repos: Repo[] }) {
  const toast = useToast();
  const [list, setList] = useState<CrewSchedule[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CrewScheduleInput | null>(null);
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.crewSchedules(member.id).then((s) => { setList(s); setError(null); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10_000); return () => clearInterval(timer); }, [member.id]);
  const next = list.find((s) => s.enabled);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await load(); setDraft(null); }
    catch (e) { toast({ text: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const canApprove = !!member.role && MAINTENANCE_ROLE[member.role].autonomy !== "observe";
  return (
    <div className="crew-schedules">
      <button type="button" className="tuning-change" aria-expanded={open} aria-label={`Schedules for ${member.name}`} onClick={() => setOpen(!open)}>
        {next ? `Next: ${new Date(next.nextFireAt).toLocaleString(undefined, { timeZone: next.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
          : list.length ? "Schedules paused" : "Add schedule"}
      </button>
      {open && <div className="crew-schedule-editor">
        <p className="muted">Runs use the member's maintenance role. Missed slots catch up once; on-call, paused, and open runs skip the slot.</p>
        {!member.role && <p className="muted">Choose a maintenance role in this member's settings before adding a schedule.</p>}
        {error && <p role="alert">{error} <button type="button" className="tuning-change" onClick={() => void load()}>Retry</button></p>}
        {list.map((s) => <div className="crew-schedule-item" key={s.id}>
          <div><strong>{crewScheduleLabel(s)}</strong> · {repos.find((r) => r.id === s.repoId)?.name ?? s.repoId}
            <div className="muted">{s.enabled ? "Enabled" : "Paused"} · {s.preApprove ? "Pre-approved" : "Waits for review"}</div>
            {s.lastOutcome && <div className="muted">{s.lastOutcome}</div>}
          </div>
          <div className="crew-schedule-actions">
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => { setDraft(s); setEditing(s.id); }}>Edit</button>
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void run(() => api.saveCrewSchedule(member.id, { ...s, enabled: !s.enabled }, s.id))}>{s.enabled ? "Pause" : "Resume"}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => api.removeCrewSchedule(member.id, s.id))}>Remove</button>
          </div>
        </div>)}
        {draft ? <form aria-label={`Schedule for ${member.name}`} onSubmit={(e) => { e.preventDefault(); void run(() => api.saveCrewSchedule(member.id, draft, editing)); }}>
          <fieldset disabled={busy} className="crew-schedule-fields">
            <label className="tuning-field">Repo<select className="input" value={draft.repoId} required onChange={(e) => setDraft({ ...draft, repoId: e.target.value })}>
              <option value="">Choose a repo</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></label>
            <div className="tuning-field"><span>Days</span><div className="crew-schedule-days">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) =>
              <label key={d}><input type="checkbox" checked={!!(draft.daysMask & (1 << i))} onChange={() => setDraft({ ...draft, daysMask: draft.daysMask ^ (1 << i) })} />{d}</label>)}</div></div>
            <label className="tuning-field">Local time<input type="time" className="input" required value={draft.localTime} onChange={(e) => setDraft({ ...draft, localTime: e.target.value })} /></label>
            <label className="tuning-field">Timezone<input className="input" required value={draft.timezone} placeholder="America/Toronto" onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></label>
            <label><input type="checkbox" checked={draft.preApprove} disabled={!canApprove && !draft.preApprove} onChange={(e) => setDraft({ ...draft, preApprove: e.target.checked })} /> Pre-approve each run</label>
            <p className="muted">{canApprove ? "Pre-approved runs merge after their checks pass. Other runs wait for review." : "Investigate-only roles have nothing to merge."} Spring clock gaps skip that day; repeated times run once at the earlier instant.</p>
            <div className="crew-schedule-actions"><button className="btn btn-primary btn-sm" disabled={!draft.daysMask}>Save schedule</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => setDraft(null)}>Cancel</button></div>
          </fieldset>
        </form> : <button type="button" className="btn btn-quiet btn-sm" disabled={busy || !member.role} onClick={() => {
          setEditing(undefined);
          setDraft({ repoId: repos.find((r) => r.isFactory)?.id ?? repos[0]?.id ?? "", daysMask: 62, localTime: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, preApprove: false, enabled: true });
        }}>Add schedule</button>}
      </div>}
    </div>
  );
}
