import { useState } from "react";
import type { Analytics } from "@crane/contracts";
import { DAY_LONG, DAY_SHORT, axisTick, dayLabel, labelsDay, niceCeil, tipPosition } from "../../lib/analytics";
import { plural, usd } from "../../lib/format";

type Day = Analytics["daily"][number];

function SpendColumn({ day, max, on, onHover }: { day: Day; max: number; on: boolean; onHover: (hovering: boolean) => void }) {
  return (
    <div
      role="listitem"
      className={`spend-col ${on ? "on" : ""}`}
      tabIndex={0}
      aria-label={`${dayLabel(day.day, DAY_LONG)}: ${usd(day.usd)}, ${plural(day.runs, "run")}`}
      onPointerEnter={() => onHover(true)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      {day.usd > 0 && <span className="spend-bar" style={{ height: `max(2px, ${(day.usd / max) * 100}%)` }} />}
    </div>
  );
}

function SpendTip({ day, style }: { day: Day; style: Record<string, string> }) {
  return (
    <div className="spend-tip" role="status" style={style}>
      <strong className="tabular">{usd(day.usd)}</strong>
      <span>
        {dayLabel(day.day, DAY_SHORT)} · {plural(day.runs, "run")}
      </span>
    </div>
  );
}

/** Daily spend as columns. Each column's full-height slot is its hover and focus target. */
export function DailyChart({ daily }: { daily: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceCeil(Math.max(...daily.map((d) => d.usd)));
  const hovered = hover !== null ? daily[hover] : undefined;
  const ticks = [max, max / 2, 0];

  return (
    <div className="spend-chart" onPointerLeave={() => setHover(null)}>
      <div className="spend-axis" aria-hidden>
        {ticks.map((t) => (
          <span key={t} className="tabular">
            {axisTick(t)}
          </span>
        ))}
      </div>
      <div className="spend-plot">
        {ticks.map((t) => (
          <div key={t} className="spend-grid" style={{ bottom: `${(t / max) * 100}%` }} aria-hidden />
        ))}
        <div className="spend-cols" role="list" aria-label="Spend by day">
          {daily.map((d, i) => (
            <SpendColumn key={d.day} day={d} max={max} on={hover === i} onHover={(hovering) => setHover(hovering ? i : null)} />
          ))}
        </div>
        {hovered && <SpendTip day={hovered} style={tipPosition(hover!, daily.length, (hovered.usd / max) * 100)} />}
      </div>
      <div className="spend-x" aria-hidden>
        {daily.map((d, i) => (
          <span key={d.day}>{labelsDay(i, daily.length) ? dayLabel(d.day) : ""}</span>
        ))}
      </div>
    </div>
  );
}
