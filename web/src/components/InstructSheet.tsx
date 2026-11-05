import { errorMessage } from "@crane/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Repo, type TaskDraft } from "../lib/api";
import { useDrivers } from "../lib/hooks";
import { canPreApprove, instructExamples } from "../lib/instruct-draft";
import { parseStartTime } from "../lib/schedule";
import { useToast } from "../lib/toast";
import { useInstructDraft } from "../lib/use-instruct-draft";
import { parseGates } from "./GateFields";
import { InstructChoices } from "./InstructChoices";
import { InstructOptions, NO_SETTINGS, type InstructSettings } from "./InstructOptions";

/** Creates the task, then leaves for its page. A failure stays on the sheet, next to what caused it. */
function useStartTask(final: TaskDraft | null, settings: InstructSettings, onClose: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();

  const submit = async () => {
    if (!final) return;
    if (!final.repoId) return setError("Choose which repo to work on.");
    setBusy(true);
    setError(null);
    try {
      const m = await api.createTask({
        kind: final.kind,
        title: final.title,
        brief: final.brief,
        repoId: final.repoId,
        autonomy: final.autonomy,
        driver: settings.driver,
        ...parseGates(settings.gates),
        lookouts: settings.lookouts,
        scheduledAt: parseStartTime(settings.startTime),
        preApprove: canPreApprove(final.autonomy) && settings.preApprove,
      });
      onClose();
      nav(`/tasks/${m.id}`);
      toast({ text: m.scheduledAt ? "Task scheduled" : "Task queued" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return { submit, busy, error };
}

function InstructPrompt({ areaRef, text, setText, repos, submit }: {
  areaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  repos: Repo[];
  submit: () => void;
}) {
  return (
    <div className="sheet-body">
      <label className="sheet-label" id="instruct-label" htmlFor="instruct-text">
        What should the factory do?
      </label>
      <textarea
        id="instruct-text"
        ref={areaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Describe the work like you'd tell a teammate. Add as much detail as you want."
      />
      {!text && (
        <div className="suggestions" aria-label="Examples">
          {instructExamples(repos).map((x) => (
            <button type="button" key={x} className="suggestion" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FootNote({ error, title }: { error: string | null; title: string | undefined }) {
  if (error) return <span className="error-text">{error}</span>;
  if (title !== undefined) return <>Starts as “{title}”</>;
  return "Nothing runs until you start it.";
}

function InstructFoot({ error, final, busy, scheduled, onClose }: {
  error: string | null;
  final: TaskDraft | null;
  busy: boolean;
  scheduled: boolean;
  onClose: () => void;
}) {
  return (
    <div className="sheet-foot">
      <span className="muted" style={{ fontSize: 13, flex: "1 1 220px", minWidth: 0 }}>
        <FootNote error={error} title={final?.title} />
      </span>
      <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!final || busy}>
          {scheduled ? "Schedule task" : "Start task"} <span className="kbd">⌘↵</span>
        </button>
      </span>
    </div>
  );
}

export function InstructSheet({ repos, onClose, initial = "" }: { repos: Repo[]; onClose: () => void; initial?: string }) {
  const { text, setText, final, override } = useInstructDraft(initial, repos);
  const [settings, setSettings] = useState(NO_SETTINGS);
  const change = (next: Partial<InstructSettings>) => setSettings((s) => ({ ...s, ...next }));
  const { drivers } = useDrivers();
  const { submit, busy, error } = useStartTask(final, settings, onClose);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (final && !canPreApprove(final.autonomy)) setSettings((s) => ({ ...s, preApprove: false }));
  }, [final?.autonomy]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="instruct-label">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <InstructPrompt areaRef={areaRef} text={text} setText={setText} repos={repos} submit={submit} />
          {final && (
            <div className="understood">
              <p className="understood-title">Here's what I understood. Tap anything to change it.</p>
              <InstructChoices
                final={final}
                repos={repos}
                override={override}
                drivers={drivers ?? []}
                driver={settings.driver}
                onDriver={(driver) => change({ driver })}
              />
              <InstructOptions settings={settings} change={change} preApprovable={canPreApprove(final.autonomy)} busy={busy} />
            </div>
          )}
          <InstructFoot error={error} final={final} busy={busy} scheduled={settings.startTime !== null} onClose={onClose} />
        </form>
      </div>
    </div>
  );
}
