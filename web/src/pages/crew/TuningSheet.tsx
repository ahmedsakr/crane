import { errorMessage } from "@crane/contracts";
import { useId, useState } from "react";
import { api, settingsLabel, type DriverInfo } from "../../lib/api";
import { useToast } from "../../lib/toast";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

/** Choose the model and effort one agent runs with. */
export function TuningSheet({ driver: d, onChange, onClose }: { driver: DriverInfo; onChange: (d: DriverInfo[]) => void; onClose: () => void }) {
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
      setError(errorMessage(e));
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
