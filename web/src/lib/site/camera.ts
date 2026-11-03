/** Perspective camera math, and hit testing on the resulting screen points. */
import { cross, dot, norm, sub, type Vec3 } from "./vec.js";

export interface Camera {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  scale: number;
  cx: number;
  cy: number;
}

/** A camera orbiting `target`: azimuth around z (−π/2 looks along +y), elevation above the ground. */
export function orbit(target: Vec3, azimuth: number, elevation: number, distance: number): Camera {
  const eye = {
    x: target.x + distance * Math.cos(elevation) * Math.cos(azimuth),
    y: target.y + distance * Math.cos(elevation) * Math.sin(azimuth),
    z: target.z + distance * Math.sin(elevation),
  };
  const fwd = norm(sub(target, eye));
  const right = norm(cross(fwd, { x: 0, y: 0, z: 1 }));
  const up = cross(right, fwd);
  return { eye, right, up, fwd, scale: 1, cx: 0, cy: 0 };
}

/** Screen position (px) and depth of a world point. */
export function project(cam: Camera, p: Vec3): { x: number; y: number; z: number } {
  const d = sub(p, cam.eye);
  const z = Math.max(0.01, dot(d, cam.fwd));
  return { x: cam.cx + (cam.scale * dot(d, cam.right)) / z, y: cam.cy - (cam.scale * dot(d, cam.up)) / z, z };
}

/** Scale and centre a camera so `points` fill a width × height box, leaving `margin` px around them. */
export function fit(cam: Camera, points: Vec3[], width: number, height: number, margin: number): Camera {
  const unit = { ...cam, scale: 1, cx: 0, cy: 0 };
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    const s = project(unit, p);
    x0 = Math.min(x0, s.x);
    x1 = Math.max(x1, s.x);
    y0 = Math.min(y0, s.y);
    y1 = Math.max(y1, s.y);
  }
  const scale = Math.max(1, Math.min((width - 2 * margin) / (x1 - x0 || 1), (height - 2 * margin) / (y1 - y0 || 1)));
  return { ...cam, scale, cx: width / 2 - (scale * (x0 + x1)) / 2, cy: height / 2 - (scale * (y0 + y1)) / 2 };
}

/** Even-odd test of a screen point against a polygon. */
export function inPolygon(x: number, y: number, pts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
