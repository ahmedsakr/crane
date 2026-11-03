/** The site's colours, read from the CSS tokens so it follows light and dark mode. */
import type { ZoneId } from "../../lib/site";

export type RGB = [number, number, number];

export interface Palette {
  ground: RGB;
  groundSide: RGB;
  pad: RGB;
  padReview: RGB;
  padReviewEdge: RGB;
  steel: RGB;
  steelOff: RGB;
  cab: RGB;
  weight: RGB;
  crate: Record<ZoneId, RGB>;
  live: RGB;
  ok: RGB;
  text: RGB;
  textStrong: RGB;
  shadow: number;
  font: string;
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const css = (c: RGB, a = 1) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${a})`;

/** Any CSS colour as RGB, normalised by the canvas itself. */
function parseColor(ctx: CanvasRenderingContext2D, value: string): RGB {
  ctx.fillStyle = "#000";
  ctx.fillStyle = value;
  const s = String(ctx.fillStyle);
  if (s.startsWith("#")) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const m = s.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128];
  return [m[0] ?? 128, m[1] ?? 128, m[2] ?? 128];
}

export function readPalette(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Palette {
  const cs = getComputedStyle(canvas);
  const v = (name: string) => parseColor(ctx, cs.getPropertyValue(name).trim() || "#888");
  const concrete = v("--concrete");
  const surface = v("--surface");
  const ink = v("--ink");
  const graphite = v("--graphite");
  const ok = v("--ok");
  const live = v("--live");
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    ground: concrete,
    groundSide: mix(concrete, ink, dark ? 0.1 : 0.13),
    pad: mix(concrete, ink, dark ? 0.07 : 0.055),
    padReview: v("--crane-soft"),
    padReviewEdge: v("--crane"),
    steel: ink,
    steelOff: graphite,
    cab: v("--ink-2"),
    weight: mix(graphite, concrete, 0.2),
    crate: {
      queued: mix(graphite, surface, 0.5),
      working: live,
      review: v("--crane"),
      merging: mix(ok, surface, 0.45),
      shipped: ok,
      stopped: v("--bad"),
    },
    live,
    ok,
    text: graphite,
    textStrong: ink,
    shadow: dark ? 0.42 : 0.13,
    font: getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim() || "sans-serif",
  };
}
