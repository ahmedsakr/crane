/** Paints one frame of the site: flat ground first, then everything else back to front. */
import type { ZoneId } from "../../lib/site";
import { addCrane } from "./crane";
import { addCrates } from "./crates";
import { paintCounts, paintGround, paintPads } from "./ground";
import { css } from "./palette";
import { outline, paintPrim, type Prim } from "./primitives";
import type { Frame, Pt } from "./scene";
import { paintShadows } from "./shadows";

/** A crate's face on screen, for pointing at it. Later ones are drawn on top. */
export interface Hit {
  id: string;
  pts: Pt[];
}

function paintGroundShadows(frame: Frame, ground: Pt[]) {
  const { ctx } = frame;
  // Shadows fall on the ground only.
  ctx.save();
  ctx.beginPath();
  ground.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.clip();
  paintShadows(frame);
  ctx.restore();
}

/** Crates and crane, far to near. Returns where the crates ended up on screen. */
function paintObjects(frame: Frame): Hit[] {
  const { ctx, cam } = frame;
  const prims: Prim[] = [];
  const out = { cam, prims };
  addCrates(frame, out);
  addCrane(frame, out);
  prims.sort((a, b) => b.z - a.z);
  const hits: Hit[] = [];
  for (const p of prims) {
    paintPrim(ctx, p);
    if (p.kind === "poly" && p.id) hits.push({ id: p.id, pts: p.pts });
  }
  return hits;
}

function paintHover({ ctx, pal, hovered }: Frame, hits: Hit[]) {
  if (!hovered) return;
  ctx.strokeStyle = css(pal.textStrong);
  ctx.lineWidth = 1.6;
  for (const hit of hits) if (hit.id === hovered) outline(ctx, hit.pts);
}

export function paintSite(frame: Frame): { hits: Hit[]; counts: Record<ZoneId, number> } {
  const { ctx, w, h, dpr } = frame;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const ground = paintGround(frame);
  paintPads(frame);
  paintGroundShadows(frame, ground);
  const hits = paintObjects(frame);
  paintHover(frame, hits);
  return { hits, counts: paintCounts(frame) };
}
