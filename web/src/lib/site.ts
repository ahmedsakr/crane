/**
 * The construction site on Home: a tower crane that carries each task, as a
 * crate, from one area of the site to the next as its status changes. This
 * module is the pure part (layout, the crane's choreography, camera math) so
 * it runs under node:test. components/site-view.ts draws it on a canvas.
 *
 * World units: x to the right, y away from the viewer, z up. The crane's mast
 * stands at the origin; the areas sit on an arc in front of it.
 */
import type { TaskSummary, TaskStatus } from "@crane/contracts";

export type Vec3 = { x: number; y: number; z: number };
export type ZoneId = "queued" | "working" | "review" | "merging" | "shipped" | "stopped";

/** Left to right, the way work moves across the site. */
export const ZONE_IDS: ZoneId[] = ["queued", "working", "review", "merging", "shipped", "stopped"];

export const ZONE_LABEL: Record<ZoneId, string> = {
  queued: "Queued",
  working: "Working",
  review: "Needs you",
  merging: "Merging",
  shipped: "Shipped",
  stopped: "Didn't ship",
};

/**
 * Where each status puts its crate. Shipped and didn't-ship follow
 * SHIPPED_STATUSES and UNSHIPPED_STATUSES, so a finished investigation lands
 * with merged work rather than being called "merged".
 */
export const ZONE_OF: Record<TaskStatus, ZoneId> = {
  queued: "queued",
  running: "working",
  needs_review: "review",
  approved: "shipped",
  merging: "merging",
  merged: "shipped",
  done: "shipped",
  rejected: "stopped",
  failed: "stopped",
  cancelled: "stopped",
};

// ── layout ────────────────────────────────────────────────

export const BOX = { w: 1.15, h: 0.8 };
/** Centre-to-centre spacing of crates in an area. */
export const PITCH = 1.4;
/** Crates stack two by two, then upwards. */
export const PER_LAYER = 4;
export const LAYERS = 4;
/** Crates beyond this in one area stay off the drawing; the area's count still includes them. */
export const CAPACITY = PER_LAYER * LAYERS;
/** Side length of an area's square pad. */
export const PAD = 3.1;

export const JIB_Z = 6.0;
export const JIB_LEN = 10.8;
export const COUNTER_LEN = 3.8;
/** Space between the hook block and the top of the crate it carries. */
export const HOOK_GAP = 0.2;
/** Hook height that carries a crate clear of the tallest stack. */
export const CLEAR_Z = LAYERS * BOX.h + BOX.h + HOOK_GAP + 0.5;
/** Where the trolley and hook rest when there's nothing to move. */
export const PARK = { r: 3.2, hookZ: JIB_Z - 1.3 };

export interface Zone {
  id: ZoneId;
  x: number;
  y: number;
  /** Bearing from the mast, so each pad faces the crane. */
  yaw: number;
}

const ZONE_X = [-9, -5.4, -1.8, 1.8, 5.4, 9];
export const ZONES = Object.fromEntries(
  ZONE_IDS.map((id, i) => {
    const x = ZONE_X[i]!;
    const y = -5.5 * Math.sqrt(1 - (x / 10) ** 2);
    return [id, { id, x, y, yaw: Math.atan2(y, x) }];
  }),
) as Record<ZoneId, Zone>;

/** A point in an area, given offsets along its radial (u) and tangential (v) axes. */
export function zonePoint(zone: ZoneId, u: number, v: number, z = 0): Vec3 {
  const { x, y, yaw } = ZONES[zone];
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: x + u * c - v * s, y: y + u * s + v * c, z };
}

/** Bottom centre of the i-th crate slot in an area, and the way it faces. */
export function slotPos(zone: ZoneId, i: number): Vec3 & { yaw: number } {
  const col = i % 2;
  const row = Math.floor(i / 2) % 2;
  const layer = Math.floor(i / PER_LAYER);
  const p = zonePoint(zone, (row - 0.5) * PITCH, (col - 0.5) * PITCH, layer * BOX.h);
  return { ...p, yaw: ZONES[zone].yaw };
}

/**
 * Angle of a point around the mast, continuous across the front of the site:
 * everything in front of the crane falls in (-π, 0), so slewing between areas
 * always swings over the site rather than behind the mast.
 */
export function bearing(x: number, y: number): number {
  const a = Math.atan2(y, x);
  return a > Math.PI / 2 ? a - 2 * Math.PI : a;
}

/** Small, stable yaw offset per crate so piles don't look machine-placed. */
export function jitter(id: string, max: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 2 * max;
}

// ── the crane and its crates ──────────────────────────────

/** The crane's moving parts: slew angle, trolley radius, hook height. */
export interface Rig {
  theta: number;
  r: number;
  hookZ: number;
}

export interface Payload {
  id: string;
  task: TaskSummary;
  /** The area the crate sits in, or was lifted from while it's carried. */
  zone: ZoneId;
  pos: Vec3;
  yaw: number;
  carried: boolean;
  /** 0 to 1: grows in when the task arrives on site, shrinks away when it leaves. */
  grow: number;
  leaving: boolean;
  /** Its colour blends from the area it came from to the one it's in. */
  paintFrom: ZoneId;
  paint: number;
}

type Phase = "approach" | "lower" | "grab" | "lift" | "carry" | "drop" | "release" | "rise";
const NEXT: Record<Phase, Phase | null> = {
  approach: "lower",
  lower: "grab",
  grab: "lift",
  lift: "carry",
  carry: "drop",
  drop: "release",
  release: "rise",
  rise: null,
};

interface Job {
  id: string;
  to: ZoneId;
  phase: Phase;
  t: number;
  dur: number;
  from: Rig;
  liftYaw: number;
}

// Top speeds; tweens ease in and out around them.
const SLEW = 1.5; // rad/s
const TROLLEY = 4.5; // units/s
const HOIST = 3.2; // units/s
const HOLD = 0.3; // s to hook on or let go

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const aim = (p: { x: number; y: number }) => ({ theta: bearing(p.x, p.y), r: Math.hypot(p.x, p.y) });

function travel(a: Rig, b: Rig, min: number): number {
  return Math.max(min, Math.abs(b.theta - a.theta) / SLEW, Math.abs(b.r - a.r) / TROLLEY, Math.abs(b.hookZ - a.hookZ) / HOIST);
}

/**
 * Crates for the tasks Home knows about, and one crane that moves them. Feed it
 * the current tasks with `sync` whenever they change and advance it with
 * `step`. Moves queue up and run one at a time; the crane speeds up when it
 * falls behind. With `instant`, every move lands at once (reduced motion).
 */
export class SiteModel {
  readonly payloads = new Map<string, Payload>();
  /** Slot order per area. A crate being carried also holds its slot at the destination. */
  readonly stacks: Record<ZoneId, string[]> = { queued: [], working: [], review: [], merging: [], shipped: [], stopped: [] };
  rig: Rig = { theta: -0.72 * Math.PI, r: PARK.r, hookZ: PARK.hookZ };
  job: Job | null = null;
  instant: boolean;
  private queue: string[] = [];
  private parking: { from: Rig; t: number; dur: number } | null = null;
  private loaded = false;
  private settling = false;

  constructor(opts: { instant?: boolean } = {}) {
    this.instant = !!opts.instant;
  }

  /** True while anything on site is moving, so the view knows to keep drawing. */
  get busy(): boolean {
    return !!this.job || this.queue.length > 0 || !!this.parking || this.settling;
  }

  /** Crates resting in an area right now (not counting one on its way in). */
  count(zone: ZoneId): number {
    let n = 0;
    for (const p of this.payloads.values()) if (p.zone === zone && !p.carried && !p.leaving) n++;
    return n;
  }

  sync(tasks: TaskSummary[]): void {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const want = ZONE_OF[task.status];
      const p = this.payloads.get(task.id);
      if (!p) {
        // Tasks on site when the page opens are already in place. Later ones
        // arrive in the queue area, and the crane takes them on from there.
        const start = !this.loaded || this.instant ? want : "queued";
        const i = this.stacks[start].push(task.id) - 1;
        const s = slotPos(start, i);
        this.payloads.set(task.id, {
          id: task.id,
          task,
          zone: start,
          pos: { x: s.x, y: s.y, z: s.z },
          yaw: s.yaw + this.tilt(task.id, start),
          carried: false,
          grow: this.loaded && !this.instant ? 0 : 1,
          leaving: false,
          paintFrom: start,
          paint: 1,
        });
        if (start !== want) this.enqueue(task.id);
        continue;
      }
      p.task = task;
      if (p.leaving) {
        p.leaving = false;
        if (!p.carried && !this.stacks[p.zone].includes(p.id)) this.stacks[p.zone].push(p.id);
      }
      const heading = this.job?.id === p.id ? this.job.to : p.zone;
      if (heading !== want) this.enqueue(p.id);
    }
    for (const p of this.payloads.values()) if (!seen.has(p.id) && !p.leaving) this.retire(p);
    this.loaded = true;
    if (this.instant) this.flush();
    this.settling = true;
  }

  /** Advance the site by `dt` seconds. */
  step(dt: number): void {
    if (this.instant && (this.job || this.queue.length)) this.flush();
    const speed = 1 + Math.min(3, this.queue.length * 0.5);
    this.advance(dt * speed);
    let moving = false;
    const k = 1 - Math.exp(-dt * 9);
    for (const p of [...this.payloads.values()]) {
      if (p.carried) {
        Object.assign(p.pos, this.hookLoad());
        moving = true;
        continue;
      }
      if (p.leaving) {
        p.grow = Math.max(0, p.grow - dt * 3);
        if (p.grow === 0) this.payloads.delete(p.id);
        moving = true;
        continue;
      }
      const i = this.stacks[p.zone].indexOf(p.id);
      if (i >= 0) {
        const s = slotPos(p.zone, i);
        const yaw = s.yaw + this.tilt(p.id, p.zone);
        const d = Math.abs(s.x - p.pos.x) + Math.abs(s.y - p.pos.y) + Math.abs(s.z - p.pos.z) + Math.abs(yaw - p.yaw);
        if (d > 0.002) {
          p.pos.x = lerp(p.pos.x, s.x, k);
          p.pos.y = lerp(p.pos.y, s.y, k);
          p.pos.z = lerp(p.pos.z, s.z, k);
          p.yaw = lerp(p.yaw, yaw, k);
          moving = true;
        } else {
          Object.assign(p.pos, { x: s.x, y: s.y, z: s.z });
          p.yaw = yaw;
        }
      }
      if (p.grow < 1) {
        p.grow = Math.min(1, p.grow + dt * 2.5);
        moving = true;
      }
      if (p.paint < 1) {
        p.paint = Math.min(1, p.paint + dt * 2.5);
        moving = true;
      }
    }
    this.settling = moving;
  }

  /** Bottom centre of a crate hanging from the hook. */
  hookLoad(): Vec3 {
    const { theta, r, hookZ } = this.rig;
    return { x: r * Math.cos(theta), y: r * Math.sin(theta), z: hookZ - HOOK_GAP - BOX.h };
  }

  /** The slot a crate is in, or the one it's headed for while carried. */
  slotOf(p: Payload): number {
    const zone = this.job?.id === p.id && p.carried ? this.job.to : p.zone;
    return this.stacks[zone].indexOf(p.id);
  }

  private tilt(id: string, zone: ZoneId): number {
    return zone === "stopped" ? jitter(id, 0.3) : zone === "queued" ? jitter(id, 0.06) : 0;
  }

  private enqueue(id: string): void {
    if (!this.queue.includes(id)) this.queue.push(id);
  }

  private retire(p: Payload): void {
    p.leaving = true;
    this.queue = this.queue.filter((id) => id !== p.id);
    // A crate on the hook gets set down first, then leaves.
    if (this.job?.id === p.id && p.carried) return;
    if (this.job?.id === p.id) {
      this.unstack(this.job.to, p.id);
      this.job = null;
    }
    this.unstack(p.zone, p.id);
  }

  /** Take a crate out of an area; the top crate fills its gap so only one moves. */
  private unstack(zone: ZoneId, id: string): void {
    const stack = this.stacks[zone];
    const i = stack.indexOf(id);
    if (i < 0) return;
    const last = stack.pop()!;
    if (last !== id) stack[i] = last;
  }

  /** The next move worth making, with its crate brought to the top of its column and its destination reserved. */
  private nextJob(): Job | null {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      const p = this.payloads.get(id);
      if (!p || p.leaving || p.carried) continue;
      const to = ZONE_OF[p.task.status];
      if (to === p.zone) continue;
      const stack = this.stacks[p.zone];
      const i = stack.indexOf(id);
      if (i < 0) continue;
      // The crane lifts from the top: swap with whatever sits above it.
      let top = i;
      while (top + PER_LAYER < stack.length) top += PER_LAYER;
      [stack[i], stack[top]] = [stack[top]!, stack[i]!];
      this.stacks[to].push(id);
      this.parking = null;
      return { id, to, phase: "approach", t: 0, dur: 0, from: { ...this.rig }, liftYaw: p.yaw };
    }
    return null;
  }

  private target(job: Job): Rig {
    const p = this.payloads.get(job.id)!;
    const dest = slotPos(job.to, Math.max(0, this.stacks[job.to].indexOf(job.id)));
    switch (job.phase) {
      case "approach":
        return { ...aim(p.pos), hookZ: CLEAR_Z };
      case "lower":
      case "grab":
        return { ...aim(p.pos), hookZ: p.pos.z + BOX.h + HOOK_GAP };
      case "lift":
      case "rise":
        return { theta: job.from.theta, r: job.from.r, hookZ: CLEAR_Z };
      case "carry":
        return { ...aim(dest), hookZ: CLEAR_Z };
      case "drop":
      case "release":
        return { ...aim(dest), hookZ: dest.z + BOX.h + HOOK_GAP };
    }
  }

  private begin(job: Job, phase: Phase): void {
    job.phase = phase;
    job.t = 0;
    job.from = { ...this.rig };
    job.dur = phase === "grab" || phase === "release" ? HOLD : travel(job.from, this.target(job), 0.35);
  }

  private advance(dt: number): void {
    if (!this.job) {
      this.job = this.nextJob();
      if (this.job) this.begin(this.job, "approach");
    }
    const job = this.job;
    if (!job) {
      this.park(dt);
      return;
    }
    job.t += dt;
    const to = this.target(job);
    const f = ease(Math.min(1, job.t / job.dur));
    this.rig = { theta: lerp(job.from.theta, to.theta, f), r: lerp(job.from.r, to.r, f), hookZ: lerp(job.from.hookZ, to.hookZ, f) };
    const p = this.payloads.get(job.id)!;
    if (job.phase === "carry") {
      const dest = slotPos(job.to, Math.max(0, this.stacks[job.to].indexOf(job.id)));
      p.yaw = lerp(job.liftYaw, dest.yaw + this.tilt(p.id, job.to), f);
    }
    if (job.t < job.dur) return;
    const leftover = job.t - job.dur;
    if (job.phase === "grab") {
      p.carried = true;
      this.unstack(p.zone, p.id);
    }
    if (job.phase === "release") this.deliver(job, p);
    const next = NEXT[job.phase];
    if (next) this.begin(job, next);
    else this.job = null;
    if (leftover > 0) this.advance(leftover);
  }

  private deliver(job: Job, p: Payload): void {
    p.carried = false;
    p.paintFrom = p.zone;
    p.paint = 0;
    p.zone = job.to;
    if (p.leaving) this.unstack(job.to, p.id);
  }

  private park(dt: number): void {
    const goal = { theta: this.rig.theta, r: PARK.r, hookZ: PARK.hookZ };
    if (!this.parking) {
      if (Math.abs(this.rig.r - goal.r) + Math.abs(this.rig.hookZ - goal.hookZ) < 0.001) return;
      this.parking = { from: { ...this.rig }, t: 0, dur: travel(this.rig, goal, 0.6) };
    }
    const pk = this.parking;
    pk.t += dt;
    const f = ease(Math.min(1, pk.t / pk.dur));
    this.rig = { theta: goal.theta, r: lerp(pk.from.r, goal.r, f), hookZ: lerp(pk.from.hookZ, goal.hookZ, f) };
    if (pk.t >= pk.dur) this.parking = null;
  }

  /** Land every pending move immediately. */
  private flush(): void {
    const finish = (job: Job) => {
      const p = this.payloads.get(job.id)!;
      if (!p.carried) this.unstack(p.zone, p.id);
      this.deliver(job, p);
    };
    if (this.job) finish(this.job);
    this.job = null;
    for (let job = this.nextJob(); job; job = this.nextJob()) finish(job);
    this.parking = null;
    for (const p of [...this.payloads.values()]) {
      if (p.leaving) {
        this.payloads.delete(p.id);
        continue;
      }
      const s = slotPos(p.zone, Math.max(0, this.stacks[p.zone].indexOf(p.id)));
      p.pos = { x: s.x, y: s.y, z: s.z };
      p.yaw = s.yaw + this.tilt(p.id, p.zone);
      p.grow = 1;
      p.paint = 1;
    }
  }
}

// ── camera ────────────────────────────────────────────────

export interface Camera {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  scale: number;
  cx: number;
  cy: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

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
