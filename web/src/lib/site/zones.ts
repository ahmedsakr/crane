/**
 * The site's layout: its areas, where crates stack in them, and the crane's
 * dimensions.
 *
 * World units: x to the right, y away from the viewer, z up. The crane's mast
 * stands at the origin; the areas sit on an arc in front of it.
 */
import type { TaskStatus } from "@crane/contracts";
import type { Vec3 } from "./vec.js";

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
