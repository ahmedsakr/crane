import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Overview } from "../lib/api";
import { hourLabel, plural, usd } from "../lib/format";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_WIDTH,
  hoverIndex,
  hoverPoint,
  slabChart,
  type SlabChart,
  type SlabRange,
  type VolumeBar,
} from "../lib/slab-chart";

const RANGES: SlabRange[] = ["1D", "1W"];

function eyebrowText(factory: Overview["factory"], working: number): string {
  if (!factory.running) return "Factory is off";
  if (factory.paused) return "Factory is paused";
  if (working) return `${plural(working, "agent")} working`;
  return "Factory is running · waiting for work";
}

function dotClass(live: boolean, paused: boolean, working: number): string {
  if (live) return working ? "dot-running" : "dot-on";
  return paused ? "dot-paused" : "";
}

function deltaLabel(delta: number): string {
  if (delta === 0) return "· level with before";
  return delta > 0 ? `· +${delta} vs before` : `· ${delta} vs before`;
}

function SlabLabel({ chart, hover, range }: { chart: SlabChart; hover: number | null; range: SlabRange }) {
  if (hover !== null) {
    const bucket = chart.buckets[hover]!;
    return (
      <div className="slab-label">
        shipped by {hourLabel(bucket.t)}
        {bucket.events ? ` · ${plural(bucket.events, "agent step")} that hour` : ""}
      </div>
    );
  }
  return (
    <div className="slab-label">
      {chart.total === 1 ? "task" : "tasks"} shipped {range === "1D" ? "today" : "this week"}
      {"  "}
      <span className="slab-delta">{deltaLabel(chart.total - chart.prevTotal)}</span>
    </div>
  );
}

function VolumeBars({ bars, hover }: { bars: VolumeBar[]; hover: number | null }) {
  return (
    <>
      {bars.map((bar, i) => bar.h > 0 && (
        <rect
          key={i}
          x={bar.x}
          y={bar.y}
          width={bar.w}
          height={bar.h}
          rx={1}
          fill="currentColor"
          opacity={hover === i ? 0.55 : 0.22}
        />
      ))}
    </>
  );
}

function HoverMarker({ x, y }: { x: number; y: number }) {
  return (
    <span
      style={{
        position: "absolute",
        left: `${(x / CHART_WIDTH) * 100}%`,
        top: y - 6,
        width: 12,
        height: 12,
        marginLeft: -6,
        borderRadius: "50%",
        background: "currentColor",
        boxShadow: "0 0 0 4px color-mix(in srgb, currentColor 18%, transparent)",
        pointerEvents: "none",
      }}
    />
  );
}

function SlabPlot({ chart, hover, range, onHover }: {
  chart: SlabChart;
  hover: number | null;
  range: SlabRange;
  onHover: (index: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const point = hover !== null ? hoverPoint(chart, hover) : null;
  const onMove = (clientX: number) => {
    if (ref.current) onHover(hoverIndex(clientX, ref.current.getBoundingClientRect(), chart.buckets.length));
  };
  return (
    <div
      className="slab-chart"
      ref={ref}
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerDown={(e) => onMove(e.clientX)}
      onPointerLeave={() => onHover(null)}
      role="img"
      aria-label={`Tasks shipped over the last ${range === "1D" ? "day" : "week"}: ${chart.total}`}
    >
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none">
        <line className="baseline" x1="0" x2={CHART_WIDTH} y1={CHART_BASELINE} y2={CHART_BASELINE} vectorEffect="non-scaling-stroke" />
        <VolumeBars bars={chart.volume} hover={hover} />
        <path className="area" d={chart.area} />
        <path
          key={range}
          className="line draw"
          d={chart.path}
          pathLength={1}
          style={{ ["--len" as string]: 1 }}
          vectorEffect="non-scaling-stroke"
        />
        {point && (
          <line x1={point.x} x2={point.x} y1={0} y2={CHART_HEIGHT} stroke="currentColor" strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {point && <HoverMarker x={point.x} y={point.y} />}
    </div>
  );
}

function SlabFoot({ o, range, onRange }: { o: Overview; range: SlabRange; onRange: (range: SlabRange) => void }) {
  return (
    <div className="slab-foot">
      <div className="ranges" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r} aria-pressed={range === r} onClick={() => onRange(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="slab-stats">
        <span>
          <b>{o.counts.running + o.counts.queued}</b> in flight
        </span>
        <span>
          <b>{o.counts.needs_review}</b> need you
        </span>
        <Link to="/analytics?days=7" className="slab-stat-link" title="See what the factory spent">
          <b>{usd(o.spendThisWeekUsd)}</b> spent this week
        </Link>
      </div>
    </div>
  );
}

export function Slab({ o }: { o: Overview }) {
  const [range, setRange] = useState<SlabRange>("1W");
  const [hover, setHover] = useState<number | null>(null);
  const live = o.factory.running && !o.factory.paused;
  const working = o.agents.filter((a) => a.state === "working").length;
  const chart = useMemo(() => slabChart(o.activity, o.shippedLastWeek, range), [o.activity, o.shippedLastWeek, range]);

  return (
    <section className={`slab ${live ? "" : "off"}`} aria-label="Factory output">
      <div className="slab-eyebrow">
        <span className={`dot ${dotClass(live, o.factory.paused, working)}`} />
        {eyebrowText(o.factory, working)}
      </div>
      <div className="slab-number" aria-live="polite">
        {hover !== null ? chart.cumulative[hover]! : chart.total}
      </div>
      <SlabLabel chart={chart} hover={hover} range={range} />
      <SlabPlot chart={chart} hover={hover} range={range} onHover={setHover} />
      <SlabFoot o={o} range={range} onRange={setRange} />
    </section>
  );
}
