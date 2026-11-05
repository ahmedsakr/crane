/** The geometry behind the home page's activity chart. Pure: no DOM and no React. */
import type { Overview } from "@crane/contracts";

export type SlabRange = "1D" | "1W";
export type ActivityBucket = Overview["activity"][number];
type Point = [number, number];

export interface VolumeBar {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlabChart {
  buckets: ActivityBucket[];
  /** Tasks shipped up to and including each bucket. */
  cumulative: number[];
  total: number;
  prevTotal: number;
  path: string;
  area: string;
  volume: VolumeBar[];
}

export const CHART_WIDTH = 1000;
export const CHART_HEIGHT = 168;
const PAD_TOP = 18;
const PAD_BOTTOM = 26; // room for the volume bars
export const CHART_BASELINE = CHART_HEIGHT - PAD_BOTTOM;
const RANGE_HOURS: Record<SlabRange, number> = { "1D": 24, "1W": 168 };

/** Monotone cubic path: smooth like a price chart, never overshoots a flat run. */
export function smoothPath(pts: Point[]): string {
  if (pts.length < 2) return "";
  const n = pts.length;
  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]![0] - pts[i]![0];
    slopes[i] = (pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1);
  }
  const tangents: number[] = [slopes[0]!];
  for (let i = 1; i < n - 1; i++) {
    tangents[i] = slopes[i - 1]! * slopes[i]! <= 0 ? 0 : (slopes[i - 1]! + slopes[i]!) / 2;
  }
  tangents[n - 1] = slopes[n - 2]!;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${x0 + h},${y0 + tangents[i]! * h} ${x1 - h},${y1 - tangents[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

function valueY(value: number, total: number): number {
  return PAD_TOP + (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM) * (1 - value / Math.max(1, total));
}

function bucketStep(count: number): number {
  return CHART_WIDTH / Math.max(1, count - 1);
}

function volumeBars(buckets: ActivityBucket[]): VolumeBar[] {
  const step = bucketStep(buckets.length);
  const busiest = Math.max(1, ...buckets.map((b) => b.events));
  const w = Math.max(1.5, step * 0.55);
  return buckets.map((b, i) => {
    const h = b.events ? Math.max(2, (b.events / busiest) * (PAD_BOTTOM - 8)) : 0;
    return { x: i * step - w / 2, y: CHART_HEIGHT - h, w, h };
  });
}

function runningTotals(buckets: ActivityBucket[]): number[] {
  let run = 0;
  return buckets.map((b) => (run += b.done));
}

/** Everything the chart draws for a range. The week compares with last week's shipped count, which outlives `activity`. */
export function slabChart(activity: ActivityBucket[], shippedLastWeek: number, range: SlabRange): SlabChart {
  const hours = RANGE_HOURS[range];
  const buckets = activity.slice(-hours);
  const cumulative = runningTotals(buckets);
  const total = cumulative.at(-1) ?? 0;
  const prevTotal = range === "1W" ? shippedLastWeek : activity.slice(-hours * 2, -hours).reduce((sum, b) => sum + b.done, 0);
  const step = bucketStep(buckets.length);
  const path = smoothPath(cumulative.map((value, i): Point => [i * step, valueY(value, total)]));
  const area = path ? `${path} L${CHART_WIDTH},${CHART_BASELINE} L0,${CHART_BASELINE} Z` : "";
  return { buckets, cumulative, total, prevTotal, path, area, volume: volumeBars(buckets) };
}

/** Which bucket a pointer is over, clamped to the chart's edges. */
export function hoverIndex(clientX: number, box: { left: number; width: number }, bucketCount: number): number {
  const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  return Math.round(fraction * (bucketCount - 1));
}

/** Where a hovered bucket sits, in chart units. */
export function hoverPoint(chart: Pick<SlabChart, "buckets" | "cumulative" | "total">, index: number): { x: number; y: number } {
  return {
    x: (index / Math.max(1, chart.buckets.length - 1)) * CHART_WIDTH,
    y: valueY(chart.cumulative[index]!, chart.total),
  };
}
