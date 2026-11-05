import { errorMessage } from "@crane/contracts";
import { useEffect, useId, useState } from "react";
import type { RetentionSettings } from "@crane/contracts";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { Chevron } from "./Chevron";
import { Section } from "./Section";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "./Sheet";

/** The sheet's fields while they're being edited. */
type RetentionForm = { enabled: boolean; days: string };

/** The saved period in one row, or why it isn't there yet. */
function RetentionSummary({ saved, error, onRetry, onEdit }: {
  saved: RetentionSettings | null;
  error: string | null;
  onRetry: () => void;
  onEdit: (saved: RetentionSettings) => void;
}) {
  if (error) return <span role="alert">{error} <button className="tuning-change" onClick={onRetry}>Retry</button></span>;
  if (!saved) return <span className="muted">Loading retention…</span>;
  const days = saved.finishedTaskDays;
  return (
    <>
      <span className="crew-who">
        <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label="Change storage retention" onClick={() => onEdit(saved)}>
          {days === null ? "Keep all history" : `Trim routine history after ${days} days`}
        </button>
        <span className="row-meta">{days === null ? "Automatic cleanup is disabled" : "Finished tasks only · tasks and runs stay"}</span>
      </span>
      <span className="crew-actions"><Chevron /></span>
    </>
  );
}

function RetentionSheet({ form, saving, error, enabling, onChange, onSave, onClose }: {
  form: RetentionForm;
  saving: boolean;
  error: string | null;
  /** Saving would turn cleanup on, so the button says that instead of "Save". */
  enabling: boolean;
  onChange: (form: RetentionForm) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  return (
    <Sheet onClose={onClose}>
      <SheetHead title="Storage retention" subtitle="Cleanup permanently deletes routine history. Back up your Crane data before enabling it." />
      <SheetBody>
        <form id={formId} className="sheet-fields" aria-label="Storage retention" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <label><input type="checkbox" checked={form.enabled} disabled={saving} onChange={(e) => onChange({ ...form, enabled: e.target.checked })} /> Enable automatic cleanup</label>
          {form.enabled && <label className="tuning-field">
            <span>Days after a task finishes</span>
            <input className="input" type="number" min="1" max="36500" step="1" required value={form.days} disabled={saving}
              onChange={(e) => onChange({ ...form, days: e.target.value })} />
          </label>}
          <p className="muted">Enabled cleanup deletes tool events and marked routine narration from finished tasks after the chosen period. Unclassified notes, status, operator, blocked, error, finding and merge records stay. Tasks and runs stay, preserving cost analytics.</p>
          <p className="muted">It also deletes screenshots no longer referenced by a report once the files are over a day old. Images for queued or active tasks stay.</p>
          <p className="muted">The running factory checks hourly. The first enabled cleanup may take longer while it rewrites an older database once to reclaim space. Disabling cleanup cannot restore deleted history.</p>
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving}>
          {enabling ? "Enable cleanup" : "Save"}
        </button>
      </SheetFoot>
    </Sheet>
  );
}

export function StorageRetention() {
  const toast = useToast();
  const [saved, setSaved] = useState<RetentionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RetentionForm>({ enabled: false, days: "30" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.retentionSettings().then(setSaved).catch((e: Error) => setError(e.message));
  };
  useEffect(() => { load(); }, []);
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await api.configureRetention({ finishedTaskDays: form.enabled ? Number(form.days) : null }));
      setEditing(false);
      toast({ text: form.enabled ? "Storage retention enabled" : "Storage retention disabled" });
    } catch (e) { setSaveError(errorMessage(e)); }
    finally { setSaving(false); }
  };
  const edit = ({ finishedTaskDays }: RetentionSettings) => {
    setForm({ enabled: finishedTaskDays !== null, days: String(finishedTaskDays ?? 30) });
    setSaveError(null);
    setEditing(true);
  };
  return (
    <Section id="storage-retention" className="crew-section" title="Storage retention"
      aside={<span className="muted crew-section-note">Choose how long to keep routine task history</span>}>
      <div className="rows card crew-list">
        <div className="crew-row crew-row-plain">
          <RetentionSummary saved={saved} error={error} onRetry={load} onEdit={edit} />
        </div>
      </div>
      {editing && (
        <RetentionSheet form={form} saving={saving} error={saveError} enabling={form.enabled && saved?.finishedTaskDays === null}
          onChange={setForm} onSave={() => void save()} onClose={() => setEditing(false)} />
      )}
    </Section>
  );
}
