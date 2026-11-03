/** What every painter shares: the scene's fixed framing, its light, and the frame being drawn. */
import {
  COUNTER_LEN,
  JIB_LEN,
  JIB_Z,
  fit,
  norm,
  orbit,
  type Camera,
  type SiteModel,
  type Vec3,
} from "../../lib/site";
import type { Palette } from "./palette";

export type Pt = { x: number; y: number; z: number };

const AZIMUTH = -Math.PI / 2 - 0.08;
const ELEVATION = 0.38;
const DISTANCE = 44;
const SWAY = 0.05;
const TARGET: Vec3 = { x: 0, y: -2.6, z: 2.4 };
export const LIGHT = norm({ x: -0.5, y: -0.8, z: 1.2 });
/** Where shadows fall, per unit of height. */
export const SHADOW = { x: 0.32, y: 0.26 };
export const GROUND = { cx: 0, cy: -2.2, rx: 12.3, ry: 6.2, depth: 0.45 };
export const APEX_Z = JIB_Z + 1.9;
export const TAU = Math.PI * 2;

export const easeInOut = (t: number) => t * t * (3 - 2 * t);

/** Everything a painter needs to draw one frame. */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  dpr: number;
  cam: Camera;
  pal: Palette;
  model: SiteModel;
  live: boolean;
  reduced: boolean;
  time: number;
  hovered: string | null;
}

/** Everything the crane can reach, in any position, plus the ground. */
function reachablePoints(): Vec3[] {
  const pts: Vec3[] = [{ x: 0, y: 0, z: APEX_Z }];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU;
    const g = { x: GROUND.cx + GROUND.rx * Math.cos(a), y: GROUND.cy + GROUND.ry * Math.sin(a) };
    pts.push({ ...g, z: 0 }, { ...g, z: -GROUND.depth });
  }
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI + (i / 12) * Math.PI;
    pts.push({ x: JIB_LEN * Math.cos(a), y: JIB_LEN * Math.sin(a), z: JIB_Z + 0.4 });
    pts.push({ x: -COUNTER_LEN * Math.cos(a), y: -COUNTER_LEN * Math.sin(a), z: JIB_Z + 0.4 });
  }
  return pts;
}

/** A camera that fits the whole site in a w × h canvas. */
export function fitSiteCamera(w: number, h: number): Camera {
  const base = orbit(TARGET, AZIMUTH, ELEVATION, DISTANCE);
  const fitted = fit(base, reachablePoints(), w, h, 10);
  // Leave room for the camera's sway.
  const s = fitted.scale * (1 - SWAY * 0.6);
  return { ...fitted, scale: s, cx: w / 2 + (fitted.cx - w / 2) * (s / fitted.scale), cy: h / 2 + (fitted.cy - h / 2) * (s / fitted.scale) };
}

/** The fitted camera for this moment; it drifts slowly while `ambient`. */
export function frameCamera(fitted: Camera, ambient: boolean, time: number): Camera {
  const sway = ambient ? Math.sin((time * TAU) / 70) * SWAY : 0;
  return { ...orbit(TARGET, AZIMUTH + sway, ELEVATION, DISTANCE), scale: fitted.scale, cx: fitted.cx, cy: fitted.cy };
}
