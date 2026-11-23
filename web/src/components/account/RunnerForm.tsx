import { useId, useState } from "react";
import { MAX_NAME_LENGTH, type RunnerSummary } from "@crane/contracts";
import { useSubmit } from "../../lib/use-submit";
import { SheetBody, SheetFoot, SheetHead } from "../Sheet";

export function RunnerForm({ runner, onSave, onBack }: {
  runner?: RunnerSummary;
  onSave: (input: { name: string; capacity: number }) => Promise<void>;
  onBack: () => void;
}) {
  const form = useId();
  const [name, setName] = useState(runner?.name ?? "");
  const [capacity, setCapacity] = useState(1);
  const { submit, busy, error } = useSubmit();
  const title = runner ? "Rename container" : "Add a container";
  return <>
    <SheetHead title={title} onBack={onBack} />
    <SheetBody>
      <form id={form} className="account-fields" onSubmit={(e) => {
        e.preventDefault();
        if (!busy && name.trim()) void submit(() => onSave({ name: name.trim(), capacity }));
      }}>
        <label className="account-field">
          <span>Name</span>
          <input className="input" required maxLength={MAX_NAME_LENGTH} value={name} disabled={busy}
            placeholder="Laptop" onChange={(e) => setName(e.target.value)} />
        </label>
        {!runner && <label className="account-field">
          <span>Capacity (jobs at once)</span>
          <select className="input" value={capacity} disabled={busy} onChange={(e) => setCapacity(Number(e.target.value))}>
            {Array.from({ length: 8 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
          </select>
        </label>}
      </form>
    </SheetBody>
    <SheetFoot note={error && <span className="error-text" role="alert">{error}</span>}>
      <button className="btn btn-primary" form={form} disabled={busy || !name.trim()}>{busy ? "Saving…" : title}</button>
    </SheetFoot>
  </>;
}
