import { COMMAND_ACCESS, COMMAND_ACCESS_LABEL, type CommandAccess, type Repo } from "@crane/contracts";
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { ACCESS_CHOICE_HINT, AUTO_MODE_NOTE, GUARD_ALWAYS_BLOCKS, GUARD_ASKS_FIRST, UNAFFECTED_NOTE } from "../../lib/command-access";
import { useToast } from "../../lib/toast";
import { useSubmit } from "../../lib/use-submit";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

/** The three choices, the current one checked, each with what it means. */
export function AccessChoices({ value, onChange, disabled }: {
  value: CommandAccess; onChange: (value: CommandAccess) => void; disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="access-choices" disabled={disabled}>
      <legend className="visually-hidden">Commands agents may run</legend>
      {COMMAND_ACCESS.map((access) => (
        <label className="access-choice" key={access}>
          <input type="radio" name={name} value={access} checked={value === access} onChange={() => onChange(access)} />
          <span>
            <strong>{COMMAND_ACCESS_LABEL[access]}</strong>
            <span className="muted">{ACCESS_CHOICE_HINT[access]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const items = (labels: Record<string, string>) => Object.entries(labels).map(([key, label]) => <li key={key}>{label}</li>);

/** The details behind the choice: what the guard blocks, and what auto mode costs. */
export function GuardDetails() {
  return (
    <details className="access-details">
      <summary>What Crane's guard blocks</summary>
      <h3>Always blocked</h3>
      <ul>{items(GUARD_ALWAYS_BLOCKS)}</ul>
      <h3>Blocked until you allow them</h3>
      <ul>{items(GUARD_ASKS_FIRST)}</ul>
      <p className="muted">When one is blocked, Allow on the blocked command lets every agent in this repo run it.</p>
      <h3>Auto mode</h3>
      <p className="muted">{AUTO_MODE_NOTE}</p>
    </details>
  );
}

/** Choose which commands Claude Code agents may run in one repo, like `crane commands`. */
export function CommandsSheet({ repo, current, onSaved, onClose }: {
  repo: Pick<Repo, "id" | "name">; current: CommandAccess; onSaved: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const formId = useId();
  const [choice, setChoice] = useState(current);
  const { busy: saving, error, submit } = useSubmit();

  const save = () => submit(async () => {
    await api.setCommandAccess(repo.id, choice);
    toast({ text: `Set commands for ${repo.name} to “${COMMAND_ACCESS_LABEL[choice]}”` });
    onSaved();
    onClose();
  });

  return (
    <Sheet onClose={onClose}>
      <SheetHead title={`Commands for ${repo.name}`} subtitle="Which commands Claude Code agents may run in this repo, from each agent's next run." />
      <SheetBody>
        <form id={formId} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <AccessChoices value={choice} onChange={setChoice} disabled={saving} />
          <p className="muted access-note">{UNAFFECTED_NOTE}</p>
          <GuardDetails />
        </form>
      </SheetBody>
      <SheetFoot note={error ? <span className="error-text" role="alert">{error}</span> : undefined}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={saving || choice === current}>Save</button>
      </SheetFoot>
    </Sheet>
  );
}
