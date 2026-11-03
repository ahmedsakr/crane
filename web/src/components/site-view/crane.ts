/** The tower crane, part by part, in the order its primitives are drawn. */
import { BOX, COUNTER_LEN, JIB_LEN, JIB_Z, type Vec3 } from "../../lib/site";
import { css, type Palette, type RGB } from "./palette";
import { box, line, type PrimList } from "./primitives";
import { APEX_Z, type Frame } from "./scene";

const FOOTING_H = 0.28;
const MAST_TOP = JIB_Z - 0.55;
const MAST_BAYS = 8;
const MAST_HALF = 0.4;
const MAST_POSTS: [number, number][] = [
  [-MAST_HALF, -MAST_HALF],
  [MAST_HALF, -MAST_HALF],
  [MAST_HALF, MAST_HALF],
  [-MAST_HALF, MAST_HALF],
];
const JIB_HALF = 0.32;
const COUNTER_HALF = 0.4;
/** Length of one section of the jib's and counter-jib's trusses. */
const TRUSS_STEP = 0.9;

/** The crane's parts share these: its colours, its pose, and a way to place points along the jib. */
interface CranePen {
  out: PrimList;
  pal: Palette;
  steelRgb: RGB;
  steel: string;
  thin: string;
  theta: number;
  r: number;
  hookZ: number;
  /** A point along the jib (u) and across it (v). */
  J: (u: number, v: number, z: number) => Vec3;
}

/** Height of the jib's top chord: level, then tapering to the tip. */
const topAt = (u: number) => (u < JIB_LEN - 2 ? 0.7 : 0.7 - (0.55 * (u - (JIB_LEN - 2))) / 2);

function addMastBay({ out, steel, thin }: CranePen, k: number, z0: number, z1: number) {
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = MAST_POSTS[i]!;
    const [bx, by] = MAST_POSTS[(i + 1) % 4]!;
    line(out, { x: ax, y: ay, z: z0 }, { x: ax, y: ay, z: z1 }, 0.07, steel);
    line(out, { x: ax, y: ay, z: z1 }, { x: bx, y: by, z: z1 }, 0.04, thin);
    if (k % 2) line(out, { x: ax, y: ay, z: z0 }, { x: bx, y: by, z: z1 }, 0.035, thin);
    else line(out, { x: bx, y: by, z: z0 }, { x: ax, y: ay, z: z1 }, 0.035, thin);
  }
}

function addMast(pen: CranePen) {
  box(pen.out, { at: { x: 0, y: 0, z: 0 }, w: 1.7, d: 1.7, h: FOOTING_H, yaw: 0, rgb: pen.pal.groundSide });
  const bay = (MAST_TOP - FOOTING_H) / MAST_BAYS;
  for (let k = 0; k < MAST_BAYS; k++) {
    const z0 = FOOTING_H + k * bay;
    addMastBay(pen, k, z0, z0 + bay);
  }
}

/** The slewing unit and cab turn with the jib. */
function addSlewUnit({ out, pal, steelRgb, theta, J }: CranePen) {
  box(out, { at: { x: 0, y: 0, z: MAST_TOP }, w: 1.0, d: 1.0, h: 0.55, yaw: theta, rgb: steelRgb });
  box(out, { at: J(0.15, 0.78, JIB_Z - 0.85), w: 0.75, d: 0.6, h: 0.62, yaw: theta, rgb: pal.cab, edge: 0.8 });
}

/** A triangular truss that tapers to the tip. */
function addJib({ out, steel, thin, J }: CranePen) {
  let u0 = 0.5;
  while (u0 < JIB_LEN - 0.01) {
    const u1 = Math.min(JIB_LEN, u0 + TRUSS_STEP);
    const t0 = J(u0, 0, JIB_Z + topAt(u0));
    const t1 = J(u1, 0, JIB_Z + topAt(u1));
    for (const v of [-JIB_HALF, JIB_HALF]) {
      line(out, J(u0, v, JIB_Z), J(u1, v, JIB_Z), 0.06, steel);
      line(out, J(u0, v, JIB_Z), t1, 0.03, thin);
      line(out, J(u1, v, JIB_Z), t1, 0.03, thin);
    }
    line(out, t0, t1, 0.05, steel);
    line(out, J(u1, -JIB_HALF, JIB_Z), J(u1, JIB_HALF, JIB_Z), 0.03, thin);
    u0 = u1;
  }
}

function addCounterJib({ out, pal, steel, thin, theta, J }: CranePen) {
  let c0 = -0.5;
  while (c0 > -COUNTER_LEN + 0.01) {
    const c1 = Math.max(-COUNTER_LEN, c0 - TRUSS_STEP);
    for (const v of [-COUNTER_HALF, COUNTER_HALF]) line(out, J(c0, v, JIB_Z), J(c1, v, JIB_Z), 0.06, steel);
    line(out, J(c1, -COUNTER_HALF, JIB_Z), J(c1, COUNTER_HALF, JIB_Z), 0.03, thin);
    line(out, J(c0, -COUNTER_HALF, JIB_Z), J(c1, COUNTER_HALF, JIB_Z), 0.03, thin);
    c0 = c1;
  }
  box(out, { at: J(-COUNTER_LEN + 0.65, 0, JIB_Z - 0.75), w: 1.1, d: 0.95, h: 0.85, yaw: theta, rgb: pal.weight, edge: 0.85 });
}

/** The tower top and the pendant lines that hold up the jibs. */
function addPendants({ out, steel, thin, J }: CranePen) {
  const apex = { x: 0, y: 0, z: APEX_Z };
  for (const [u, v] of [
    [0.45, 0.45],
    [0.45, -0.45],
    [-0.45, 0.45],
    [-0.45, -0.45],
  ] as const)
    line(out, J(u, v, JIB_Z), apex, 0.06, steel);
  line(out, apex, J(JIB_LEN * 0.55, 0, JIB_Z + topAt(JIB_LEN * 0.55)), 0.025, thin);
  line(out, apex, J(JIB_LEN - 0.4, 0, JIB_Z + topAt(JIB_LEN - 0.4)), 0.025, thin);
  for (const v of [-COUNTER_HALF, COUNTER_HALF]) line(out, apex, J(-COUNTER_LEN, v, JIB_Z), 0.025, thin);
}

function addTrolley({ out, steelRgb, theta, r, J }: CranePen) {
  box(out, { at: J(r, 0, JIB_Z - 0.22), w: 0.6, d: 0.78, h: 0.22, yaw: theta, rgb: steelRgb });
}

/** Hoist cables and the hook block. */
function addHook({ out, steelRgb, steel, theta, r, hookZ, J }: CranePen) {
  for (const v of [-0.1, 0.1]) line(out, J(r, v, JIB_Z - 0.22), J(r, v, hookZ + 0.3), 0.022, steel);
  box(out, { at: J(r, 0, hookZ), w: 0.34, d: 0.3, h: 0.3, yaw: theta, rgb: steelRgb });
}

/** Slings down to the crate on the hook, if there is one. */
function addSlings({ out, thin, r, hookZ, J }: CranePen, { model }: Frame) {
  const load = model.job ? model.payloads.get(model.job.id) : undefined;
  if (!load?.carried) return;
  const cy = Math.cos(load.yaw);
  const sy = Math.sin(load.yaw);
  const hw = BOX.w / 2 - 0.08;
  const z = load.pos.z + BOX.h;
  const hook = J(r, 0, hookZ);
  for (const [i, j] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const)
    line(out, hook, { x: load.pos.x + (i * cy - j * sy) * hw, y: load.pos.y + (i * sy + j * cy) * hw, z }, 0.018, thin);
}

export function addCrane(frame: Frame, out: PrimList) {
  const { pal, model, live } = frame;
  const steelRgb = live ? pal.steel : pal.steelOff;
  const { theta, r, hookZ } = model.rig;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const pen: CranePen = {
    out,
    pal,
    steelRgb,
    steel: css(steelRgb),
    thin: css(steelRgb, 0.75),
    theta,
    r,
    hookZ,
    J: (u, v, z) => ({ x: u * c - v * s, y: u * s + v * c, z }),
  };
  addMast(pen);
  addSlewUnit(pen);
  addJib(pen);
  addCounterJib(pen);
  addPendants(pen);
  addTrolley(pen);
  addHook(pen);
  addSlings(pen, frame);
}
