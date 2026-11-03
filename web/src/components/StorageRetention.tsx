import { useEffect, useId, useState } from "react";
import type { RetentionSettings } from "@crane/contracts";
import { api } from "../lib/api";
import { Chevron, useToast } from "./bits";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "./Sheet";

export function StorageRetention() {
  const formId = useId();
  const toast = useToast();
  const [saved, setSaved] = useState<RetentionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState("30");
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
      setSaved(await api.configureRetention({ finishedTaskDays: enabled ? Number(days) : null }));
      setEditing(false);
      toast({ text: enabled ? "Storage retention enabled" : "Storage retention disabled" });
    } catch (e) { setSaveError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <section className="section crew-section" aria-labelledby="storage-retention">
      <div className="section-head">
        <h2 className="section-title" id="storage-retention">Storage retention</h2>
        <span className="muted crew-section-note">Choose how long to keep routine task history</span>
      </div>
      <div className="rows card crew-list">
        <div className="crew-row crew-row-plain">
          {error ? <span role="alert">{error} <button className="tuning-change" onClick={load}>Retry</button></span>
            : !saved ? <span className="muted">Loading retention…</span> : <>
              <span className="crew-who">
                <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label="Change storage retention"
                  onClick={() => {
                    setEnabled(saved.finishedTaskDays !== null);
                    setDays(String(saved.finishedTaskDays ?? 30));
                    setSaveError(null);
                    setEditing(true);
                  }}>
                  {saved.finishedTaskDays === null ? "Keep all history" : `Trim routine history after ${saved.finishedTaskDays} days`}
                </button>
                <span className="row-meta">{saved.finishedTaskDays === null ? "Automatic cleanup is disabled" : "Finished tasks only · tasks and runs stay"}</span>
              </span>
              <span className="crew-actions"><Chevron /></span>
            </>}
        </div>
      </div>
      {editing && <Sheet onClose={() => setEditing(false)}>
        <SheetHead title="Storage retention" subtitle="Cleanup permanently deletes routine history. Back up your Crane data before enabling it." />
        <SheetBody>
          <form id={formId} className="sheet-fields" aria-label="Storage retention" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label><input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => setEnabled(e.target.checked)} /> Enable automatic cleanup</label>
            {enabled && <label className="tuning-field">
              <span>Days after a task finishes</span>
              <input className="input" type="number" min="1" max="36500" step="1" required value={days} disabled={saving}
                onChange={(e) => setDays(e.target.value)} />
            </label>}
            <p className="muted">Enabled cleanup deletes tool events and marked routine narration from finished tasks after the chosen period. Unclassified notes, status, operator, blocked, error, finding and merge records stay. Tasks and runs stay, preserving cost analytics.</p>
            <p className="muted">It also deletes screenshots no longer referenced by a report once the files are over a day old. Images for queued or active tasks stay.</p>
            <p className="muted">The running factory checks hourly. The first enabled cleanup may take longer while it rewrites an older database once to reclaim space. Disabling cleanup cannot restore deleted history.</p>
          </form>
        </SheetBody>
        <SheetFoot note={saveError ? <span className="error-text" role="alert">{saveError}</span> : undefined}>
          <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving}>
            {enabled && saved?.finishedTaskDays === null ? "Enable cleanup" : "Save"}
          </button>
        </SheetFoot>
      </Sheet>}
    </section>
  );
}
