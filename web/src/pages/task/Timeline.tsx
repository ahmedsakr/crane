import { Component, createRef, useMemo, useRef, useState } from "react";
import { actorLabel, eventActor, type TaskEvent } from "@crane/contracts";
import { Section } from "../../components/Section";
import { clock, plural } from "../../lib/format";
import { groupEvents, keyTimeline, type TimelineEntry, type ToolGroupKeys } from "./task-view";

const PAGE_SIZE = 50;
const EDGE_DISTANCE = 32;

/** Who made an operator decision, as quiet text after it; nothing when it was unattributed. */
function EventActorName({ event }: { event: TaskEvent }) {
  const actor = event.type === "operator" ? eventActor(event) : null;
  return actor ? <span className="muted"> · {actorLabel(actor)}</span> : null;
}

function ToolSteps({ tools }: { tools: TaskEvent[] }) {
  const [open, setOpen] = useState(false);
  const folded = !open && tools.length > 1;
  return (
    <>
      {(folded ? tools.slice(0, 1) : tools).map((e) => (
        <li key={e.id} className={folded ? undefined : "tl tl-tool"}>
          {folded ? (
            <button className="tool-fold" onClick={() => setOpen(true)}>
              {plural(tools.length, "step")}: {e.message}, … <span aria-hidden>▸</span>
            </button>
          ) : <><span className="tl-time">{clock(e.ts)}</span>{e.message}</>}
        </li>
      ))}
    </>
  );
}

/**
 * Timeline entries keyed by event ID, with each tool group keeping its key as older or newer events extend it.
 * Tool folds stay within each shown batch, so prepending rows leaves existing folds and open steps in place.
 */
function useTimelineEntries(events: TaskEvent[], starts: number[]): TimelineEntry[] {
  const known = useRef<ToolGroupKeys>(new Map());
  return useMemo(() => {
    const groups = starts.flatMap((start, i) => groupEvents(events.slice(start, starts[i + 1])));
    const keyed = keyTimeline(groups, known.current);
    known.current = keyed.known;
    return keyed.entries;
  }, [events, starts]);
}

function TimelineRows({ events, starts }: { events: TaskEvent[]; starts: number[] }) {
  const entries = useTimelineEntries(events, starts);
  return (
    <ol className="timeline">
      {entries.map(({ key, item: g }) => {
        if ("tools" in g) return <ToolSteps key={key} tools={g.tools} />;
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

type TimelineProps = { events: TaskEvent[]; live: boolean };
type TimelineState = { starts: number[] };
type ScrollSnapshot = {
  anchor?: { row: HTMLElement; offset: number };
  follow?: boolean;
  restoreFocus?: boolean;
};

function visibleRow(body: HTMLElement) {
  const top = body.getBoundingClientRect().top;
  for (const row of body.querySelectorAll<HTMLElement>(".timeline > li")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) return { row, offset: rect.top - top };
  }
}

export class Timeline extends Component<TimelineProps, TimelineState, ScrollSnapshot> {
  state: TimelineState = { starts: [] };
  private body = createRef<HTMLDivElement>();
  private olderButton = createRef<HTMLButtonElement>();
  private lastScrollTop = 0;

  static getDerivedStateFromProps({ events }: TimelineProps, { starts }: TimelineState) {
    if (starts.length || !events.length) return null;
    return { starts: [Math.max(0, events.length - PAGE_SIZE)] };
  }

  componentDidMount() {
    const body = this.body.current!;
    body.scrollTop = body.scrollHeight;
    this.lastScrollTop = body.scrollTop;
  }

  getSnapshotBeforeUpdate(previous: TimelineProps, previousState: TimelineState): ScrollSnapshot {
    const body = this.body.current!;
    const first = this.state.starts[0] ?? 0;
    if (first < (previousState.starts[0] ?? 0)) {
      return {
        anchor: visibleRow(body),
        restoreFocus: first === 0 && document.activeElement === this.olderButton.current,
      };
    }
    const appended = (this.props.events.at(-1)?.id ?? 0) > (previous.events.at(-1)?.id ?? 0);
    return { follow: appended && body.scrollHeight - body.clientHeight - body.scrollTop <= EDGE_DISTANCE };
  }

  componentDidUpdate(_previous: TimelineProps, _state: TimelineState, snapshot: ScrollSnapshot) {
    const body = this.body.current!;
    if (snapshot.anchor) {
      const { row, offset } = snapshot.anchor;
      body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
      this.lastScrollTop = body.scrollTop;
    } else if (snapshot.follow) {
      body.scrollTop = body.scrollHeight;
      this.lastScrollTop = body.scrollTop;
    }
    if (snapshot.restoreFocus) body.focus({ preventScroll: true });
  }

  private showOlder = () => {
    this.setState(({ starts }) => {
      const first = starts[0] ?? 0;
      if (first === 0) return null;
      return { starts: [Math.max(0, first - PAGE_SIZE), ...starts] };
    });
  };

  private onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop } = event.currentTarget;
    const goingUp = scrollTop < this.lastScrollTop;
    this.lastScrollTop = scrollTop;
    if (goingUp && scrollTop <= EDGE_DISTANCE && (this.state.starts[0] ?? 0) > 0) this.showOlder();
  };

  render() {
    const { events, live } = this.props;
    const { starts } = this.state;
    const older = (starts[0] ?? 0) > 0;
    return (
      <Section id="task-activity" title={<>Activity {live && <span className="dot dot-running" title="Live" />}</>}
        aside={older && <button type="button" ref={this.olderButton} className="btn btn-quiet"
          aria-controls="task-activity-body" onClick={this.showOlder}>Show older entries</button>}>
        <div ref={this.body} id="task-activity-body" className="task-widget-body task-activity-body" role="region"
          aria-labelledby="task-activity" tabIndex={0} onScroll={this.onScroll}>
          <TimelineRows events={events} starts={starts} />
        </div>
      </Section>
    );
  }
}
