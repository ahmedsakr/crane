import { useState } from "react";
import { actorLabel, eventActor, type TaskEvent } from "@crane/contracts";
import { clock, plural } from "../../lib/format";
import { groupEvents } from "./task-view";

/** Who made an operator decision, as quiet text after it; nothing when it was unattributed. */
function EventActorName({ event }: { event: TaskEvent }) {
  const actor = event.type === "operator" ? eventActor(event) : null;
  return actor ? <span className="muted"> · {actorLabel(actor)}</span> : null;
}

function ToolSteps({ tools, open, onOpen }: { tools: TaskEvent[]; open: boolean; onOpen: () => void }) {
  if (open || tools.length === 1) {
    return <>
      {tools.map((e) => (
        <li key={e.id} className="tl tl-tool">
          <span className="tl-time">{clock(e.ts)}</span>
          {e.message}
        </li>
      ))}
    </>;
  }
  return (
    <li>
      <button className="tool-fold" onClick={onOpen}>
        {plural(tools.length, "step")}: {tools[0]!.message}, … <span aria-hidden>▸</span>
      </button>
    </li>
  );
}

export function Timeline({ events }: { events: TaskEvent[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <ol className="timeline">
      {groupEvents(events).map((g, i) => {
        if ("tools" in g) return <ToolSteps key={`g${i}`} tools={g.tools} open={open.has(i)} onOpen={() => setOpen(new Set(open).add(i))} />;
        return (
          <li key={g.id} className={`tl tl-${g.type}`}>
            <span className="tl-time">{clock(g.ts)}</span>
            <span className="tl-msg">{g.message}</span>
            <EventActorName event={g} />
          </li>
        );
      })}
    </ol>
  );
}
