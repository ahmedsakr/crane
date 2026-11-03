/** Soft shadows on the ground: crates, the mast, and the jib, which shows which way the crane is turned. */
import { BOX, CAPACITY, COUNTER_LEN, JIB_LEN, JIB_Z, project, type Payload, type Vec3 } from "../../lib/site";
import { polygon } from "./primitives";
import { SHADOW, easeInOut, type Frame, type Pt } from "./scene";

const shadowFill = (alpha: number) => `rgb(0 0 0 / ${alpha})`;

/** Where a point's shadow lands on the ground, on screen, as if it stood at height `z`. */
const onGround = ({ cam }: Frame, p: Vec3, z = p.z): Pt => project(cam, { x: p.x + SHADOW.x * z, y: p.y + SHADOW.y * z, z: 0.004 });

/** The shadow of a long thin part running from `a` to `b`. */
function paintBand(frame: Frame, a: Vec3, b: Vec3, width: number, alpha: number) {
  const { ctx } = frame;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const ox = (-dy / l) * (width / 2);
  const oy = (dx / l) * (width / 2);
  const pts = [
    onGround(frame, { x: a.x + ox, y: a.y + oy, z: a.z }),
    onGround(frame, { x: b.x + ox, y: b.y + oy, z: b.z }),
    onGround(frame, { x: b.x - ox, y: b.y - oy, z: b.z }),
    onGround(frame, { x: a.x - ox, y: a.y - oy, z: a.z }),
  ];
  ctx.fillStyle = shadowFill(alpha);
  polygon(ctx, pts, ctx.fillStyle, null, 0);
}

function paintCraneShadow(frame: Frame) {
  const { pal, model } = frame;
  const { theta, r, hookZ } = model.rig;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  paintBand(frame, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: JIB_Z }, 0.8, pal.shadow * 0.55);
  paintBand(frame, { x: c * 0.5, y: s * 0.5, z: JIB_Z }, { x: c * JIB_LEN, y: s * JIB_LEN, z: JIB_Z }, 0.55, pal.shadow * 0.45);
  paintBand(frame, { x: -c * 0.5, y: -s * 0.5, z: JIB_Z }, { x: -c * COUNTER_LEN, y: -s * COUNTER_LEN, z: JIB_Z }, 0.8, pal.shadow * 0.5);
  paintBand(frame, { x: c * r, y: s * r, z: JIB_Z }, { x: c * r, y: s * r, z: hookZ }, 0.08, pal.shadow * 0.5);
}

function paintCrateShadow(frame: Frame, p: Payload) {
  const { ctx, pal } = frame;
  const g = easeInOut(p.grow);
  const w = (BOX.w * g) / 2 + 0.06;
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  const corner = (i: number, j: number) => onGround(frame, { x: p.pos.x + (i * cy - j * sy) * w, y: p.pos.y + (i * sy + j * cy) * w, z: p.pos.z }, p.pos.z);
  const alpha = pal.shadow * (p.carried ? Math.max(0.3, 1 - p.pos.z / 9) : 1);
  ctx.fillStyle = shadowFill(alpha);
  polygon(ctx, [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], ctx.fillStyle, null, 0);
}

export function paintShadows(frame: Frame) {
  const { model } = frame;
  paintCraneShadow(frame);
  for (const p of model.payloads.values()) {
    if (!p.carried && (p.pos.z > 0.05 || model.slotOf(p) >= CAPACITY)) continue;
    paintCrateShadow(frame, p);
  }
}
