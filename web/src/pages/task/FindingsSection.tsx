import { Link } from "react-router-dom";
import type { DriverInfo, Finding, FollowUpState, Task } from "@crane/contracts";
import { FollowUpForm } from "../../components/FollowUpForm";
import { Section } from "../../components/Section";
import { StatusChip } from "../../components/Status";
import { api, followUpFor, STATUS_LABEL, type FollowUpOptions } from "../../lib/api";
import type { TaskActions } from "./task-actions";
import { canStartFollowUp } from "./task-view";

function FollowUpLink({ started }: { started: FollowUpState }) {
  return (
    <Link className="finding-follow-up" to={`/tasks/${started.id}`} title={started.title}
      aria-label={`Follow-up ${started.id}: ${STATUS_LABEL[started.status]}`}>
      <StatusChip status={started.status} />
      <span>Follow-up <span className="mono">{started.id}</span></span>
    </Link>
  );
}

function FollowUpSlot({ task, index, drivers, busy, onSubmit, onClose }: {
  task: Task;
  index: number;
  drivers: DriverInfo[] | null;
  busy: boolean;
  onSubmit: (opts: FollowUpOptions) => Promise<unknown>;
  onClose: () => void;
}) {
  if (drivers?.length) return <FollowUpForm key={`${task.id}-${index}`} task={task} drivers={drivers} busy={busy} onSubmit={onSubmit} onClose={onClose} />;
  return <p className="follow-up-form muted">{drivers ? "Couldn't load agents. Reload to try again." : "Loading agents…"}</p>;
}

function FindingCopy({ finding }: { finding: Finding }) {
  return (
    <div style={{ minWidth: 0 }}>
      <h4>{finding.title}</h4>
      <p>{finding.detail}</p>
      <div className="chips">
        <span className={`chip ${finding.impact === "high" ? "chip-crane" : ""}`}>{finding.impact} impact</span>
        <span className="chip">{finding.effort} effort</span>
      </div>
    </div>
  );
}

/** The report's findings, each with the follow-up it started or the way to start one. `open` is the finding whose form shows. */
export function FindingsSection({ task, followUps, drivers, open, onOpenChange, refresh, actions }: {
  task: Task;
  followUps: FollowUpState[];
  drivers: DriverInfo[] | null;
  open: number | null;
  onOpenChange: (finding: number | null) => void;
  refresh: () => Promise<unknown> | void;
  actions: TaskActions;
}) {
  const findings = task.report?.findings ?? [];
  if (findings.length === 0) return null;
  const { busy, run } = actions;

  // Stay here so the finding shows its follow-up's state, and the operator can act on the next finding.
  const followUp = (i: number, opts: FollowUpOptions) =>
    run("f" + i, async () => {
      const next = await api.followUp(task.id, i, opts);
      // Load its state before closing the form, so the finding goes straight from "Scheduling…" to it.
      await refresh();
      return next;
    },
      (r) => ({ text: "Follow-up queued", link: { to: `/tasks/${(r as { id: string }).id}`, label: "Open" } }),
      () => onOpenChange(null));

  return (
    <Section title={<>Findings <span className="count">{findings.length}</span></>}>
      <div className="card">
        {findings.map((finding, i) => {
          const started = followUpFor(followUps, i);
          const canStart = canStartFollowUp(started);
          return (
            <div className="finding" key={i}>
              <FindingCopy finding={finding} />
              <div className="finding-actions">
                {started && <FollowUpLink started={started} />}
                {canStart && (
                  <button className="btn btn-quiet btn-sm" disabled={busy} aria-expanded={open === i} onClick={() => onOpenChange(open === i ? null : i)}>
                    Make this change
                  </button>
                )}
              </div>
              {canStart && open === i && (
                <FollowUpSlot task={task} index={i} drivers={drivers} busy={busy} onSubmit={(opts) => followUp(i, opts)} onClose={() => onOpenChange(null)} />
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
