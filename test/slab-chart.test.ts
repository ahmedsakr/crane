import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHART_BASELINE,
  CHART_HEIGHT,
  CHART_WIDTH,
  hoverIndex,
  hoverPoint,
  slabChart,
  smoothPath,
  type ActivityBucket,
} from "../web/src/lib/slab-chart.ts";

const bucket = (done: number, events = 0): ActivityBucket => ({ t: "2026-01-01T00:00:00.000Z", done, events });
const numbers = (path: string) => [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

test("smoothPath: fewer than two points draw nothing", () => {
  assert.equal(smoothPath([]), "");
  assert.equal(smoothPath([[0, 10]]), "");
});

test("smoothPath: starts and ends on the data, with one curve per gap", () => {
  const path = smoothPath([[0, 80], [500, 80], [1000, 18]]);
  assert.match(path, /^M0,80 C/);
  assert.match(path, / 1000,18$/);
  assert.equal(path.match(/C/g)?.length, 2);
});

test("smoothPath: a flat run stays flat and a rise never overshoots", () => {
  const values = numbers(smoothPath([[0, 80], [500, 80], [1000, 18]]));
  const ys = values.filter((_, i) => i % 2 === 1);
  assert.deepEqual(ys.slice(0, 4), [80, 80, 80, 80], "the flat first segment has flat control points");
  for (const y of ys) assert.ok(y <= 80 && y >= 18, `${y} overshoots the data`);
});

test("smoothPath: points sharing an x don't divide by zero", () => {
  assert.doesNotMatch(smoothPath([[5, 10], [5, 20], [9, 30]]), /NaN|Infinity/);
});

test("slabChart: running totals, and the highest point reaches the top padding", () => {
  const chart = slabChart([bucket(1), bucket(0), bucket(1)], 0, "1W");
  assert.deepEqual(chart.cumulative, [1, 1, 2]);
  assert.equal(chart.total, 2);
  assert.match(chart.path, /^M0,80 /);
  assert.match(chart.path, / 1000,18$/);
});

test("slabChart: the area closes along the baseline", () => {
  const { path, area } = slabChart([bucket(1), bucket(2)], 0, "1W");
  assert.equal(area, `${path} L${CHART_WIDTH},${CHART_BASELINE} L0,${CHART_BASELINE} Z`);
});

test("slabChart: bars scale to the busiest hour and quiet hours have none", () => {
  const { volume } = slabChart([bucket(0, 2), bucket(0, 0), bucket(0, 4)], 0, "1W");
  assert.deepEqual(volume, [
    { x: -137.5, y: CHART_HEIGHT - 9, w: 275, h: 9 },
    { x: 362.5, y: CHART_HEIGHT, w: 275, h: 0 },
    { x: 862.5, y: CHART_HEIGHT - 18, w: 275, h: 18 },
  ]);
});

test("slabChart: a tiny hour keeps a visible bar", () => {
  const activity = Array.from({ length: 168 }, (_, i) => bucket(0, i === 0 ? 1 : 1000));
  assert.equal(slabChart(activity, 0, "1W").volume[0]!.h, 2);
});

test("slabChart: 1D shows the last day and compares with the day before", () => {
  const activity = [...Array.from({ length: 24 }, () => bucket(2)), ...Array.from({ length: 24 }, () => bucket(1))];
  const chart = slabChart(activity, 99, "1D");
  assert.equal(chart.buckets.length, 24);
  assert.equal(chart.total, 24);
  assert.equal(chart.prevTotal, 48);
});

test("slabChart: 1W compares with last week's shipped count", () => {
  const chart = slabChart(Array.from({ length: 200 }, () => bucket(1)), 7, "1W");
  assert.equal(chart.buckets.length, 168);
  assert.equal(chart.total, 168);
  assert.equal(chart.prevTotal, 7);
});

test("slabChart: no activity and a single bucket draw no line", () => {
  const empty = slabChart([], 3, "1W");
  assert.deepEqual([empty.total, empty.path, empty.area, empty.volume], [0, "", "", []]);
  const single = slabChart([bucket(1, 1)], 0, "1W");
  assert.deepEqual([single.total, single.path, single.area], [1, "", ""]);
  assert.equal(single.volume.length, 1);
});

test("hoverIndex: rounds to the nearest bucket and clamps to the chart", () => {
  const box = { left: 100, width: 200 };
  assert.equal(hoverIndex(100, box, 5), 0);
  assert.equal(hoverIndex(200, box, 5), 2);
  assert.equal(hoverIndex(300, box, 5), 4);
  assert.equal(hoverIndex(0, box, 5), 0, "left of the chart");
  assert.equal(hoverIndex(900, box, 5), 4, "right of the chart");
});

test("hoverPoint: sits on the line for the hovered bucket", () => {
  const chart = slabChart([bucket(1), bucket(0), bucket(1)], 0, "1W");
  assert.deepEqual(hoverPoint(chart, 0), { x: 0, y: 80 });
  assert.deepEqual(hoverPoint(chart, 2), { x: 1000, y: 18 });
  assert.deepEqual(hoverPoint(slabChart([bucket(0)], 0, "1W"), 0), { x: 0, y: CHART_BASELINE });
});
