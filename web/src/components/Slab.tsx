import { useMemo, useRef, useState } from "react";
import type { Overview } from "../lib/api";
import { hourLabel, plural, usd } from "../lib/format";

type Range = "1D" | "1W";
const W = 1000;
const H = 168;
const PAD_TOP = 18;
const PAD_BOTTOM = 26; // room for the volume bars

/** Monotone cubic path: smooth like a price chart, never overshoots a flat run. */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]![0] - pts[i]![0];
    m[i] = (pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  t[n - 1] = m[n - 2]!;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${x0 + h},${y0 + t[i]! * h} ${x1 - h},${y1 - t[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

export function Slab({ o }: { o: Overview }) {
  const [range, setRange] = useState<Range>("1W");
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const live = o.factory.running && !o.factory.paused;
  const working = o.agents.filter((a) => a.state === "working").length;

  const { buckets, cumulative, path, area, volume, total, prevTotal } = useMemo(() => {
    const hours = range === "1D" ? 24 : 168;
    const all = o.activity;
    const buckets = all.slice(-hours);
    const prev = all.slice(-hours * 2, -hours);
    let run = 0;
    const cumulative = buckets.map((b) => (run += b.done));
    const total = run;
    const prevTotal = range === "1W" ? o.shippedLastWeek : prev.reduce((s, b) => s + b.done, 0);
    const maxY = Math.max(1, total);
    const step = W / Math.max(1, buckets.length - 1);
    const y = (v: number) => PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - v / maxY);
    const pts = cumulative.map((v, i) => [i * step, y(v)] as [number, number]);
    const path = smoothPath(pts);
    const area = path ? `${path} L${W},${H - PAD_BOTTOM} L0,${H - PAD_BOTTOM} Z` : "";
    const maxE = Math.max(1, ...buckets.map((b) => b.events));
    const bw = Math.max(1.5, step * 0.55);
    const volume = buckets.map((b, i) => ({
      x: i * step - bw / 2,
      h: b.events ? Math.max(2, (b.events / maxE) * (PAD_BOTTOM - 8)) : 0,
      w: bw,
    }));
    return { buckets, cumulative, path, area, volume, total, prevTotal, step, y };
  }, [o.activity, o.shippedLastWeek, range]);

  const shown = hover !== null ? cumulative[hover]! : total;
  const delta = total - prevTotal;

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setHover(Math.round(f * (buckets.length - 1)));
  };

  const hx = hover !== null ? (hover / Math.max(1, buckets.length - 1)) * W : 0;
  const maxY = Math.max(1, total);
  const hy = hover !== null ? PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - cumulative[hover]! / maxY) : 0;

  const eyebrow = !o.factory.running
    ? "Factory is off"
    : o.factory.paused
      ? "Factory is paused"
      : working
        ? `${plural(working, "agent")} working`
        : "Factory is running · waiting for work";

  return (
    <section className={`slab ${live ? "" : "off"}`} aria-label="Factory output">
      <div className="slab-eyebrow">
        <span className={`dot ${live ? (working ? "dot-running" : "dot-on") : o.factory.paused ? "dot-paused" : ""}`} />
        {eyebrow}
      </div>
      <div className="slab-number" aria-live="polite">
        {shown}
      </div>
      <div className="slab-label">
        {hover !== null ? (
          <>
            shipped by {hourLabel(buckets[hover]!.t)}
            {buckets[hover]!.events ? ` · ${plural(buckets[hover]!.events, "agent step")} that hour` : ""}
          </>
        ) : (
          <>
            {total === 1 ? "mission" : "missions"} shipped {range === "1D" ? "today" : "this week"}
            {"  "}
            <span className="slab-delta">
              {delta === 0 ? "· level with before" : delta > 0 ? `· +${delta} vs before` : `· ${delta} vs before`}
            </span>
          </>
        )}
      </div>

      <div
        className="slab-chart"
        ref={ref}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Missions shipped over the last ${range === "1D" ? "day" : "week"}: ${total}`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <line className="baseline" x1="0" x2={W} y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM} vectorEffect="non-scaling-stroke" />
          {volume.map((v, i) =>
            v.h ? (
              <rect
                key={i}
                x={v.x}
                y={H - v.h}
                width={v.w}
                height={v.h}
                rx={1}
                fill="currentColor"
                opacity={hover === i ? 0.55 : 0.22}
              />
            ) : null,
          )}
          <path className="area" d={area} />
          <path
            key={range}
            className="line draw"
            d={path}
            pathLength={1}
            style={{ ["--len" as string]: 1 }}
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && (
            <line x1={hx} x2={hx} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.35} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {hover !== null && (
          <span
            style={{
              position: "absolute",
              left: `${(hx / W) * 100}%`,
              top: hy - 6,
              width: 12,
              height: 12,
              marginLeft: -6,
              borderRadius: "50%",
              background: "currentColor",
              boxShadow: "0 0 0 4px color-mix(in srgb, currentColor 18%, transparent)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      <div className="slab-foot">
        <div className="ranges" role="group" aria-label="Time range">
          {(["1D", "1W"] as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
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
          <span>
            <b>{usd(o.spendThisWeekUsd)}</b> spent this week
          </span>
        </div>
      </div>
    </section>
  );
}
