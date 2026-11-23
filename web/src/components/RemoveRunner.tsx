import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import { useSubmit } from "../lib/use-submit";
import { SheetBody, SheetFoot, SheetHead } from "./Sheet";

export function RemoveRunner({ id, name, onBack, onRemoved }: {
  id: string;
  name: string;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const { refresh } = useApp();
  const { submit, busy, error } = useSubmit();
  const remove = () => submit(async () => {
    await api.removeRunner(id);
    refresh();
    onRemoved();
  });
  return <>
    <SheetHead title={`Remove ${name}?`} onBack={onBack} />
    <SheetBody>
      <p>Removing this container revokes its token. Tasks waiting for it need a new place to run.</p>
    </SheetBody>
    <SheetFoot note={error && <span className="error-text" role="alert">{error}</span>}>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void remove()}>
        {busy ? "Removing…" : "Remove container"}
      </button>
    </SheetFoot>
  </>;
}
