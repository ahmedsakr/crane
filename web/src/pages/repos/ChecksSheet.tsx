import type { Repo } from "@crane/contracts";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { parseCheckCommands } from "../../lib/repos";
import { useToast } from "../../lib/toast";
import { useSubmit } from "../../lib/use-submit";
import { Sheet, SheetBody, SheetFoot, SheetHead } from "../../components/Sheet";

/** The saved commands as editable text: null until they load. */
function useSavedChecks(repoId: string) {
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let stale = false;
    api.repoChecks(repoId).then(
      (saved) => { if (!stale) setText(saved.join("\n")); },
      (e: Error) => { if (!stale) setLoadError(e.message); },
    );
    return () => { stale = true; };
  }, [repoId]);
  return { text, setText, loadError };
}

function checksNote(error: string, loaded: boolean, commandCount: number): ReactNode {
  if (error) return <span className="error-text" role="alert">{error}</span>;
  if (loaded && !commandCount) return "With no checks, work in this repo can't pass review or merge.";
  return undefined;
}

/** Edit the commands a repo's work must pass. Save stays off until the saved list has loaded, so a failed load can't wipe it. */
export function ChecksSheet({ repo, onClose }: { repo: Pick<Repo, "id" | "name">; onClose: () => void }) {
  const toast = useToast();
  const formId = useId();
  const { text, setText, loadError } = useSavedChecks(repo.id);
  const { busy: saving, error: saveError, submit } = useSubmit();
  const commands = parseCheckCommands(text ?? "");

  const save = () => submit(async () => {
    await api.configureChecks(repo.id, commands);
    toast({ text: `Saved checks for ${repo.name}` });
    onClose();
  });

  return (
    <Sheet onClose={onClose}>
      <SheetHead title={`Checks for ${repo.name}`} subtitle="What work must pass before review and merge. Crane runs these itself, in the task's worktree." />
      <SheetBody>
        <form id={formId} className="sheet-fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="tuning-field">
            <span>Shell commands, one per line</span>
            <textarea className="input mono" rows={5} value={text ?? ""} disabled={text === null || saving}
              placeholder={text === null ? "" : "npm test"} spellCheck={false} autoComplete="off"
              onChange={(e) => setText(e.target.value)} />
          </label>
        </form>
      </SheetBody>
      <SheetFoot note={checksNote(loadError || saveError, text !== null, commands.length)}>
        <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" type="submit" form={formId} disabled={text === null || saving}>Save</button>
      </SheetFoot>
    </Sheet>
  );
}
