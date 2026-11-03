/**
 * Drawing's building blocks: polygons painted straight onto the canvas, and
 * lines, boxes and glows collected as primitives to paint back to front.
 */
import { dot, project, sub, type Camera, type Vec3 } from "../../lib/site";
import { css, mix, shade, type RGB } from "./palette";
import { LIGHT, TAU, type Pt } from "./scene";

export type Prim =
  | { kind: "poly"; z: number; pts: Pt[]; fill: string; edge: string; id?: string }
  | { kind: "line"; z: number; a: Pt; b: Pt; color: string; width: number }
  | { kind: "glow"; z: number; p: Pt; r: number; color: RGB; alpha: number };

/** Where lines and boxes collect: the primitives so far, and the camera they're seen through. */
export interface PrimList {
  cam: Camera;
  prims: Prim[];
}

/** A flat-shaded box standing on `at`, `w` long along `yaw` and `d` across. */
export interface BoxSpec {
  at: Vec3;
  w: number;
  d: number;
  h: number;
  yaw: number;
  rgb: RGB;
  id?: string;
  edge?: number;
  /** Draws a crate's lid seam on its sides. */
  lid?: boolean;
}

function tracePolygon(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
}

export function polygon(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string | null, edge: string | null, width: number) {
  tracePolygon(ctx, pts);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (edge && width) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

/** Strokes a polygon with whatever stroke style is already set. */
export function outline(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  tracePolygon(ctx, pts);
  ctx.stroke();
}

export function line(out: PrimList, a: Vec3, b: Vec3, width: number, color: string) {
  const pa = project(out.cam, a);
  const pb = project(out.cam, b);
  const z = (pa.z + pb.z) / 2;
  out.prims.push({ kind: "line", z, a: pa, b: pb, color, width: Math.max(0.7, (width * out.cam.scale) / z) });
}

/** A box's visible candidates: its top and four sides, each with its outward normal and corners. */
function boxFaces(cy: number, sy: number): { n: Vec3; v: [number, number, number][] }[] {
  return [
    { n: { x: 0, y: 0, z: 1 }, v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: { x: cy, y: sy, z: 0 }, v: [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]] },
    { n: { x: -cy, y: -sy, z: 0 }, v: [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]] },
    { n: { x: -sy, y: cy, z: 0 }, v: [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]] },
    { n: { x: sy, y: -cy, z: 0 }, v: [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]] },
  ];
}

const along = (a: Vec3, b: Vec3, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export function box(out: PrimList, spec: BoxSpec) {
  const { cam, prims } = out;
  const { at: c, w, d, h, rgb, id, edge, lid } = spec;
  const cy = Math.cos(spec.yaw);
  const sy = Math.sin(spec.yaw);
  const corner = (i: number, j: number, k: number): Vec3 => ({
    x: c.x + (i * cy * w) / 2 - (j * sy * d) / 2,
    y: c.y + (i * sy * w) / 2 + (j * cy * d) / 2,
    z: c.z + k * h,
  });
  for (const f of boxFaces(cy, sy)) {
    const world = f.v.map(([i, j, k]) => corner(i, j, k));
    const mid = {
      x: (world[0]!.x + world[2]!.x) / 2,
      y: (world[0]!.y + world[2]!.y) / 2,
      z: (world[0]!.z + world[2]!.z) / 2,
    };
    if (dot(f.n, sub(cam.eye, mid)) <= 0) continue;
    const k = 0.66 + 0.34 * Math.max(0, dot(f.n, LIGHT));
    const fill = shade(rgb, k);
    const pts = world.map((p) => project(cam, p));
    const z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    prims.push({ kind: "poly", z, pts, fill: css(fill), edge: css(edge ? shade(fill, edge) : fill), id });
    if (lid && f.n.z === 0) {
      const pa = project(cam, along(world[0]!, world[3]!, 0.76));
      const pb = project(cam, along(world[1]!, world[2]!, 0.76));
      prims.push({ kind: "line", z: z - 0.001, a: pa, b: pb, color: css(shade(fill, 0.82)), width: 1 });
    }
  }
}

function paintGlow(ctx: CanvasRenderingContext2D, p: Extract<Prim, { kind: "glow" }>) {
  const g = ctx.createRadialGradient(p.p.x, p.p.y, 0, p.p.x, p.p.y, p.r);
  g.addColorStop(0, css(p.color, p.alpha));
  g.addColorStop(0.35, css(p.color, p.alpha * 0.6));
  g.addColorStop(1, css(p.color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.p.x, p.p.y, p.r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = css(mix(p.color, [255, 255, 255], 0.5), Math.min(1, p.alpha + 0.2));
  ctx.beginPath();
  ctx.arc(p.p.x, p.p.y, Math.max(1.2, p.r * 0.22), 0, TAU);
  ctx.fill();
}

export function paintPrim(ctx: CanvasRenderingContext2D, p: Prim) {
  if (p.kind === "poly") {
    polygon(ctx, p.pts, p.fill, p.edge, 0.8);
  } else if (p.kind === "line") {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width;
    ctx.beginPath();
    ctx.moveTo(p.a.x, p.a.y);
    ctx.lineTo(p.b.x, p.b.y);
    ctx.stroke();
  } else {
    paintGlow(ctx, p);
  }
}
