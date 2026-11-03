/** What's painted flat on the site: the ground slab, the area pads and their counts. */
import { PAD, ZONE_IDS, dot, norm, project, sub, zonePoint, type Vec3, type ZoneId } from "../../lib/site";
import { css, mix, shade } from "./palette";
import { outline, polygon } from "./primitives";
import { GROUND, LIGHT, TAU, type Frame, type Pt } from "./scene";

/** The site's ground, a shallow elliptical slab. Returns its top outline on screen. */
export function paintGround({ ctx, cam, pal }: Frame): Pt[] {
  const n = 72;
  const top: Pt[] = [];
  const ring: { p: Vec3; n: Vec3 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const p = { x: GROUND.cx + GROUND.rx * Math.cos(a), y: GROUND.cy + GROUND.ry * Math.sin(a), z: 0 };
    ring.push({ p, n: norm({ x: Math.cos(a) / GROUND.rx, y: Math.sin(a) / GROUND.ry, z: 0 }) });
    top.push(project(cam, p));
  }
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const nrm = norm({ x: a.n.x + b.n.x, y: a.n.y + b.n.y, z: 0 });
    if (dot(nrm, sub(cam.eye, a.p)) <= 0) continue;
    const below = (p: Vec3) => project(cam, { ...p, z: -GROUND.depth });
    const fill = css(shade(pal.groundSide, 0.86 + 0.14 * Math.max(0, dot(nrm, LIGHT))));
    polygon(ctx, [project(cam, a.p), project(cam, b.p), below(b.p), below(a.p)], fill, fill, 0.8);
  }
  polygon(ctx, top, css(pal.ground), css(mix(pal.ground, pal.groundSide, 0.6)), 1);
  return top;
}

export function paintPads({ ctx, cam, pal }: Frame) {
  const h = PAD / 2;
  for (const id of ZONE_IDS) {
    const pts = [
      zonePoint(id, -h, -h, 0),
      zonePoint(id, h, -h, 0),
      zonePoint(id, h, h, 0),
      zonePoint(id, -h, h, 0),
    ].map((p) => project(cam, p));
    const review = id === "review";
    const fill = css(review ? pal.padReview : pal.pad);
    ctx.lineJoin = "round";
    polygon(ctx, pts, fill, fill, 5);
    if (review) {
      ctx.strokeStyle = css(pal.padReviewEdge);
      ctx.lineWidth = 1.5;
      outline(ctx, pts);
    }
  }
}

/** Each area's crate count in front of its pad; the legend under the drawing names them. */
export function paintCounts({ ctx, cam, pal, model }: Frame): Record<ZoneId, number> {
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = `700 12px ${pal.font}`;
  const counts = {} as Record<ZoneId, number>;
  for (const id of ZONE_IDS) {
    const n = (counts[id] = model.count(id));
    const at = project(cam, zonePoint(id, PAD / 2 + 0.75, 0, 0));
    ctx.fillStyle = css(n ? pal.textStrong : pal.text);
    ctx.fillText(String(n), at.x, at.y);
  }
  return counts;
}
