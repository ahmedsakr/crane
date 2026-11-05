import { errorMessage } from "@crane/contracts";
import { useState } from "react";
import { useApp } from "../../lib/app-context";
import { api, settingsLabel, type DriverInfo } from "../../lib/api";
import { useToast } from "../../lib/toast";
import { Chevron } from "../../components/Chevron";
import { Section } from "../../components/Section";
import { TuningSheet } from "./TuningSheet";

/** An agent's name: the way into its settings when it has any, plain text when it doesn't. */
function DriverName({ d, tunable, onEdit }: { d: DriverInfo; tunable: boolean; onEdit: () => void }) {
  if (tunable) {
    return <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label={`Change ${d.label} model and effort`} onClick={onEdit}>{d.label}</button>;
  }
  return <span className="agent-name" style={d.available ? undefined : { color: "var(--graphite)" }}>{d.label}</span>;
}

function DriverRow({ d, busy, onChoose, onEdit }: { d: DriverInfo; busy: boolean; onChoose: () => void; onEdit: () => void }) {
  const tunable = d.available && d.efforts.length > 0;
  return (
    <li>
      <div className="crew-row crew-row-plain">
        <span className="crew-who">
          <DriverName d={d} tunable={tunable} onEdit={onEdit} />
          <span className="row-meta">{tunable ? settingsLabel(d) ?? "Default model and effort" : d.hint}</span>
        </span>
        <span className="crew-actions">
          {d.isDefault ? <span className="chip chip-crane">default</span> : d.available && (
            <button className="btn btn-quiet btn-sm" disabled={busy} onClick={onChoose}>Make default</button>
          )}
          {tunable && <Chevron />}
        </span>
      </div>
    </li>
  );
}

/** The agents the crew can run on. The default is what new tasks use unless the operator picks another. */
export function RunsOn({ drivers, onChange }: { drivers: DriverInfo[]; onChange: (d: DriverInfo[]) => void }) {
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
      toast({ text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };
  const open = drivers.find((d) => d.name === editing);

  return (
    <Section id="crew-runs-on" className="crew-section" title="Runs on"
      aside={<span className="muted crew-section-note">Crew members use the default unless you choose an agent for them</span>}>
      <ul className="rows card crew-list">
        {drivers.map((d) => (
          <DriverRow key={d.name} d={d} busy={!!busy} onChoose={() => void choose(d)} onEdit={() => setEditing(d.name)} />
        ))}
      </ul>
      {open && <TuningSheet driver={open} onChange={onChange} onClose={() => setEditing(null)} />}
    </Section>
  );
}
