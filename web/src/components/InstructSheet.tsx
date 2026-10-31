import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, AUTONOMY_LABEL, KIND_LABEL, type Autonomy, type MissionDraft, type MissionKind, type Repo } from "../lib/api";
import { useToast } from "./bits";

const AUTONOMY_HINT: Record<Autonomy, string> = {
  observe: "Reads and reports back. Never changes a file.",
  propose: "Works on its own branch, then waits for you.",
  act: "Works on its own branch and finishes on its own.",
};

const KIND_HINT: Record<MissionKind, string> = {
  maintenance: "Fixes, upgrades, flaky tests, cleanup",
  repo_feature: "Something new for one of your repos",
  factory_feature: "Something new for Crane itself",
};

interface Option<T> {
  value: T;
  label: string;
  hint?: string;
}

function Choice<T extends string | null>(props: {
  k: string;
  value: T;
  label: string;
  why: string;
  options: Option<T>[];
  onChange: (v: T) => void;
  unset?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="choice" ref={ref}>
      <button
        type="button"
        className={`choice-btn ${props.unset ? "unset" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="choice-k">{props.k}</span>
        <span className="choice-v">{props.label}</span>
        <span className="choice-why">{props.why}</span>
      </button>
      {open && (
        <ul className="menu" role="menu">
          {props.options.map((o) => (
            <li key={String(o.value)}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.value === props.value}
                onClick={() => {
                  props.onChange(o.value);
                  setOpen(false);
                }}
              >
                <strong style={{ fontWeight: 600, fontSize: 14 }}>{o.label}</strong>
                {o.hint && <small>{o.hint}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InstructSheet({ repos, onClose, initial = "" }: { repos: Repo[]; onClose: () => void; initial?: string }) {
  const [text, setText] = useState(initial);
  const [draft, setDraft] = useState<MissionDraft | null>(null);
  const [overrides, setOverrides] = useState<Partial<Pick<MissionDraft, "kind" | "repoId" | "autonomy">>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Re-read the instruction as the operator types.
  useEffect(() => {
    if (text.trim().length < 4) return setDraft(null);
    const t = setTimeout(() => api.draft(text).then(setDraft).catch(() => {}), 220);
    return () => clearTimeout(t);
  }, [text]);

  const repoById = new Map(repos.map((r) => [r.id, r]));
  const final = draft
    ? {
        ...draft,
        ...overrides,
        why: {
          kind: overrides.kind ? "You chose this" : draft.why.kind,
          repo: overrides.repoId !== undefined ? "You chose this" : draft.why.repo,
          autonomy: overrides.autonomy ? "You chose this" : draft.why.autonomy,
        },
      }
    : null;
  if (final && final.repoId && repoById.get(final.repoId)?.isFactory) final.kind = "factory_feature";

  const examples = (() => {
    const target = repos.find((r) => !r.isFactory)?.name ?? "my-app";
    return [
      `Investigate why the tests are flaky in ${target}`,
      `Find dependencies in ${target} with security advisories`,
      `Research how to add audit logging to ${target}`,
      "Research what Crane should build next to need me less",
    ];
  })();

  const submit = async () => {
    if (!final) return;
    if (!final.repoId) return setError("Choose which repo to work on.");
    setBusy(true);
    setError(null);
    try {
      const m = await api.createMission({
        kind: final.kind,
        title: final.title,
        brief: final.brief,
        repoId: final.repoId,
        autonomy: final.autonomy,
      });
      onClose();
      nav(`/missions/${m.id}`);
      toast({ text: "Mission started" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="instruct-label">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
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
                {examples.map((x) => (
                  <button type="button" key={x} className="suggestion" onClick={() => setText(x)}>
                    {x}
                  </button>
                ))}
              </div>
            )}
          </div>

          {final && (
            <div className="understood">
              <p className="understood-title">Here's what I understood. Tap anything to change it.</p>
              <div className="choices">
                <Choice
                  k="Repo"
                  value={final.repoId}
                  unset={!final.repoId}
                  label={final.repoId ? repoById.get(final.repoId)?.name ?? "—" : "Choose a repo"}
                  why={final.why.repo}
                  options={repos.map((r) => ({ value: r.id, label: r.name, hint: r.isFactory ? "Crane itself" : r.path }))}
                  onChange={(v) => setOverrides((o) => ({ ...o, repoId: v }))}
                />
                <Choice
                  k="Type"
                  value={final.kind}
                  label={KIND_LABEL[final.kind]}
                  why={final.why.kind}
                  options={(Object.keys(KIND_LABEL) as MissionKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], hint: KIND_HINT[k] }))}
                  onChange={(v) => setOverrides((o) => ({ ...o, kind: v }))}
                />
                <Choice
                  k="Freedom"
                  value={final.autonomy}
                  label={AUTONOMY_LABEL[final.autonomy]}
                  why={final.why.autonomy}
                  options={(Object.keys(AUTONOMY_LABEL) as Autonomy[]).map((a) => ({
                    value: a,
                    label: AUTONOMY_LABEL[a],
                    hint: AUTONOMY_HINT[a],
                  }))}
                  onChange={(v) => setOverrides((o) => ({ ...o, autonomy: v }))}
                />
              </div>
            </div>
          )}

          <div className="sheet-foot">
            <span className="muted" style={{ fontSize: 13, flex: "1 1 220px", minWidth: 0 }}>
              {error ? <span className="error-text">{error}</span> : final ? <>Starts as “{final.title}”</> : "Nothing runs until you start it."}
            </span>
            <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!final || busy}>
                Start mission <span className="kbd">⌘↵</span>
              </button>
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
