import type { CrewSchedule } from "@crane/contracts";
import { Link } from "react-router-dom";
import { isOnCall, memberStatus, type CrewInput, type Member } from "../../lib/crew";
import { ago } from "../../lib/format";
import { nextSchedule, whenLabel } from "../../lib/schedule";
import { Chevron } from "../../components/Chevron";
import { Avatar } from "../../components/MemberSheet";

/** What a member is on: their task, or else when their schedules next bring them in. */
function MemberWork({ m: { a, doing, waiting }, schedules }: { m: Member; schedules: CrewSchedule[] }) {
  const pending = doing ?? waiting;
  if (pending) {
    return (
      <>
        <Link to={`/tasks/${pending.id}`} className="crew-task">{pending.title}</Link>
        <span className="row-meta">{doing ? `Started ${ago(doing.startedAt)}` : `Queued for ${a.name}`}</span>
      </>
    );
  }
  if (isOnCall(a)) return null;
  const next = nextSchedule(schedules);
  if (next) return <span className="muted">Next run: {whenLabel(Date.parse(next.nextFireAt), { timeZone: next.timezone })}</span>;
  return schedules.length > 0 ? <span className="muted">Schedules paused</span> : null;
}

/** One crew member: who, what they're on, and the one action that matters now. Everything else is in their sheet. */
export function MemberRow({ m, schedules, compact, saving, configure, onOpen, onRun }: {
  m: Member;
  schedules: CrewSchedule[];
  compact?: boolean;
  saving: boolean;
  configure: (input: CrewInput) => void;
  onOpen: () => void;
  onRun: () => void;
}) {
  const { a, role } = m;
  return (
    <li>
      <div className={`crew-row${compact ? " crew-row-compact" : ""}`}>
        <Avatar a={a} />
        <span className="crew-who">
          <span className="crew-name">
            <button type="button" className="crew-open agent-name" aria-haspopup="dialog" aria-label={`${a.name}: open details`} onClick={onOpen}>{a.name}</button>
            {a.state === "working" && <span className="dot dot-running" aria-label="Working" />}
          </span>
          <span className="row-meta">{memberStatus(m)}</span>
        </span>
        <span className="crew-what">
          <MemberWork m={m} schedules={schedules} />
        </span>
        <span className="crew-actions">
          {role && a.active && (
            <button className="btn btn-quiet btn-sm" title={role.summary} aria-label={`Start maintenance run for ${a.name}`} disabled={saving} onClick={onRun}>
              {role.action}
            </button>
          )}
          {isOnCall(a) && (
            <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => configure({ active: true })}>
              Activate
            </button>
          )}
          <Chevron />
        </span>
      </div>
    </li>
  );
}
