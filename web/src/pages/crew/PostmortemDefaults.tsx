import { errorMessage } from "@crane/contracts";
import { useEffect, useId, useState } from "react";
import { useApp } from "../../lib/app-context";
import { api, driverLabel, settingsLabel, type Agent, type DriverInfo, type PostmortemSettings } from "../../lib/api";
import { useToast } from "../../lib/toast";
import { Chevron } from "../../components/Chevron";
import { Section } from "../../components/Section";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

/** Tick who runs post-mortems, on-call members included. Nobody ticked leaves them to any active member. */
function PostmortemCrewField({ agents, crew, disabled, onChange }: { agents: Agent[]; crew: string[]; disabled: boolean; onChange: (crew: string[]) => void }) {
  return (
    <fieldset className="postmortem-crew" disabled={disabled}>
      <legend>Who can run them</legend>
      <div className="postmortem-crew-list">
        {agents.map((a) => (
          <label key={a.id}>
            <input type="checkbox" checked={crew.includes(a.id)}
              onChange={(e) => onChange(e.target.checked ? [...crew, a.id] : crew.filter((id) => id !== a.id))} />
            {a.name}<span className="muted">{a.active ? "Active" : "On-call"}</span>
          </label>
        ))}
      </div>
      <span className="crew-field-note">
        {crew.length
          ? "Only these members run post-mortems. On-call members come in for them and take no other work."
          : "No one ticked: any active member can run them."}
      </span>
    </fieldset>
  );
}

/** The saved defaults in one row, or why they aren't there yet. */
function PostmortemSummary({ agents, saved, error, onRetry, onEdit }: {
  agents: Agent[];
  saved: PostmortemSettings | null;
  error: string | null;
  onRetry: () => void;
  onEdit: () => void;
}) {
  if (error) return <span role="alert">{error} <button className="tuning-change" onClick={onRetry}>Retry</button></span>;
  if (!saved) return <span className="muted">Loading defaults…</span>;
  const named = agents.filter((a) => saved.crew.includes(a.id)).map((a) => `${a.name}${a.active ? "" : " (on-call)"}`);
  return (
    <>
      <span className="crew-who">
        <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label="Change post-mortem settings" onClick={onEdit}>
          Run by {named.length ? named.join(", ") : "any active member"}
        </button>
        <span className="row-meta">{saved.driver ? driverLabel(saved.driver) : "Merged task's agent"} · {settingsLabel(saved) ?? "Agent settings"}</span>
      </span>
      <span className="crew-actions"><Chevron /></span>
    </>
  );
}

/** Model and effort, for an agent that offers them. */
function PostmortemTuningFields({ driver, draft, disabled, onChange }: {
  driver: DriverInfo;
  draft: PostmortemSettings;
  disabled: boolean;
  onChange: (draft: PostmortemSettings) => void;
}) {
  return (
    <>
      <label className="tuning-field">
        <span>Model</span>
        <input className="input" aria-label="Post-mortem model" list="postmortem-models" value={draft.model ?? ""}
          placeholder="Agent setting" disabled={disabled} onChange={(e) => onChange({ ...draft, model: e.target.value || null })} />
        <datalist id="postmortem-models">{driver.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <label className="tuning-field">
        <span>Effort</span>
        <select className="input" aria-label="Post-mortem effort" value={draft.effort ?? ""} disabled={disabled}
          onChange={(e) => onChange({ ...draft, effort: e.target.value || null })}>
          <option value="">Agent setting</option>
          {driver.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
    </>
  );
}

function PostmortemSheet({ agents, drivers, draft, saving, error, onChange, onSave, onClose }: {
  agents: Agent[];
  drivers: DriverInfo[];
  draft: PostmortemSettings;
  saving: boolean;
  error: string | null;
  onChange: (draft: PostmortemSettings) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const selected = drivers.find((d) => d.name === draft.driver);
  return (
    <Sheet onClose={onClose}>
      <SheetHead title="Post-mortem settings" subtitle="Who can run them applies right away, including to reviews already waiting. The agent, model, and effort apply when a review is queued." />
      <SheetBody>
        <form id={formId} className="sheet-fields" aria-label="Post-mortem settings" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <PostmortemCrewField agents={agents} crew={draft.crew} disabled={saving} onChange={(crew) => onChange({ ...draft, crew })} />
          <label className="tuning-field">
            <span>Agent</span>
            <select className="input" aria-label="Post-mortem agent" value={draft.driver ?? ""} disabled={saving}
              onChange={(e) => onChange({ ...draft, driver: (e.target.value || null) as PostmortemSettings["driver"], model: null, effort: null })}>
              <option value="">Merged task's agent</option>
              {drivers.map((d) => <option key={d.name} value={d.name} disabled={!d.available}>{d.label}{!d.available ? " (not installed)" : ""}</option>)}
            </select>
          </label>
          {!!selected?.efforts.length && <PostmortemTuningFields driver={selected} draft={draft} disabled={saving} onChange={onChange} />}
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving}>Save</button>
      </SheetFoot>
    </Sheet>
  );
}

/** Who runs the read-only review queued after a merge, and its independent defaults. */
export function PostmortemDefaults({ drivers }: { drivers: DriverInfo[] }) {
  const { overview, refresh } = useApp();
  const agents = overview?.agents ?? [];
  const toast = useToast();
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
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await api.configurePostmortem(draft));
      setDraft(null);
      toast({ text: "Post-mortem settings saved" });
      refresh();
    } catch (e) { setSaveError(errorMessage(e)); }
    finally { setSaving(false); }
  };
  return (
    <Section id="crew-postmortems" className="crew-section" title="Post-mortems"
      aside={<span className="muted crew-section-note">A read-only review of task friction, queued after each merge</span>}>
      <div className="rows card crew-list">
        <div className="crew-row crew-row-plain">
          <PostmortemSummary agents={agents} saved={saved} error={error} onRetry={load}
            onEdit={() => { setSaveError(null); setDraft(saved); }} />
        </div>
      </div>
      {draft && (
        <PostmortemSheet agents={agents} drivers={drivers} draft={draft} saving={saving} error={saveError}
          onChange={setDraft} onSave={() => void save()} onClose={() => setDraft(null)} />
      )}
    </Section>
  );
}
