import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ScheduleFields } from "./ScheduleFields";
import { parseStartTime, startSummary } from "../lib/schedule";
import { api, AUTONOMY_LABEL, KIND_LABEL, choosableDrivers, type Autonomy, type Lookout, type TaskDraft, type TaskKind, type Repo } from "../lib/api";
import { placeMenu, type MenuPlace } from "../lib/placement";
import { useDrivers } from "../lib/hooks";
import { useToast } from "./bits";
import { GateFields, NO_GATES, parseGates } from "./GateFields";
import { LookoutFields } from "./LookoutFields";

const AUTONOMY_HINT: Record<Autonomy, string> = {
  observe: "Reads and reports back. Never changes a file.",
  propose: "Works on its own branch, then waits for you.",
  act: "Works on its own branch and finishes on its own.",
};

const KIND_HINT: Record<TaskKind, string> = {
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
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    // Escape closes the menu first; the sheet only closes on a second press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // The menu lives in a portal with fixed positioning so the sheet and the
  // scrolling scrim can never clip it. Place it against the button, flip it
  // above when there is more room there, and keep it inside the viewport.
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const update = () => {
      const btn = btnRef.current;
      const menu = menuRef.current;
      if (!btn || !menu) return;
      setPlace(
        placeMenu(
          btn.getBoundingClientRect(),
          { width: menu.offsetWidth, height: menu.scrollHeight },
          { width: document.documentElement.clientWidth, height: window.innerHeight },
        ),
      );
    };
    // Follow the button when the scrim (or anything else) scrolls, but not when
    // the operator scrolls the menu's own list.
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && update();
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, props.options.length]);

  return (
    <div className="choice">
      <button
        ref={btnRef}
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
      {open &&
        createPortal(
          <ul
            className="menu"
            role="menu"
            ref={menuRef}
            style={
              place
                ? { top: place.top, bottom: place.bottom, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight }
                : { visibility: "hidden" }
            }
          >
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
          </ul>,
          document.body,
        )}
    </div>
  );
}

export function InstructSheet({ repos, onClose, initial = "" }: { repos: Repo[]; onClose: () => void; initial?: string }) {
  const [text, setText] = useState(initial);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [overrides, setOverrides] = useState<Partial<Pick<TaskDraft, "kind" | "repoId" | "autonomy">>>({});
  // Null is "the default agent". Only asked about when more than one agent is installed.
  const [driver, setDriver] = useState<string | null>(null);
  const { drivers } = useDrivers();
  const agents = choosableDrivers(drivers ?? []);
  const defaultAgent = drivers?.find((d) => d.isDefault);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gates, setGates] = useState(NO_GATES);
  const [lookouts, setLookouts] = useState<Lookout[]>([]);
  const [startTime, setStartTime] = useState<string | null>(null);
  const [preApprove, setPreApprove] = useState(false);
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
  useEffect(() => {
    if (final?.autonomy === "observe") setPreApprove(false);
  }, [final?.autonomy]);

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
      const m = await api.createTask({
        kind: final.kind,
        title: final.title,
        brief: final.brief,
        repoId: final.repoId,
        autonomy: final.autonomy,
        driver,
        ...parseGates(gates),
        lookouts,
        scheduledAt: parseStartTime(startTime),
        preApprove: final.autonomy !== "observe" && preApprove,
      });
      onClose();
      nav(`/tasks/${m.id}`);
      toast({ text: m.scheduledAt ? "Task scheduled" : "Task queued" });
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
                  options={(Object.keys(KIND_LABEL) as TaskKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], hint: KIND_HINT[k] }))}
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
                {agents.length > 1 && (
                  <Choice
                    k="Agent"
                    value={driver ?? defaultAgent?.name ?? null}
                    label={agents.find((a) => a.name === driver)?.label ?? defaultAgent?.label ?? "Default"}
                    why={driver ? "You chose this" : "Your default agent"}
                    options={agents.map((a) => ({ value: a.name, label: a.label, hint: a.isDefault ? `Your default. ${a.hint}` : a.hint }))}
                    // Choosing the default is the same as not choosing: the task follows the default.
                    onChange={(v) => setDriver(v === defaultAgent?.name ? null : v)}
                  />
                )}
              </div>
              <LookoutFields value={lookouts} onChange={setLookouts} disabled={busy} />
              <details className="gates">
                <summary>Start time <span className="muted">· {startSummary(startTime)}</span></summary>
                <ScheduleFields value={startTime} onChange={setStartTime} disabled={busy} />
              </details>
              {final.autonomy !== "observe" && (
                <details className="gates">
                  <summary>Merge when it passes <span className="muted">· {preApprove ? "On" : "Off"}</span></summary>
                  <div className="gates-fields">
                    <label>
                      <input type="checkbox" checked={preApprove} onChange={(e) => setPreApprove(e.target.checked)} disabled={busy} />
                      {" "}Pre-approve this task
                    </label>
                    <small>Crane merges it once its run, acceptance criteria, and checks pass. Pre-approval also waives visual review, including conflict resolutions. You can undo pre-approval before the run finishes.</small>
                  </div>
                </details>
              )}
              <GateFields value={gates} onChange={setGates} disabled={busy} />
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
                {startTime === null ? "Start task" : "Schedule task"} <span className="kbd">⌘↵</span>
              </button>
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
