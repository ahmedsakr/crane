/** The crates on site, and the work lights on the ones in progress. */
import { BOX, CAPACITY, project, type Payload } from "../../lib/site";
import { mix } from "./palette";
import { box, type PrimList } from "./primitives";
import { easeInOut, type Frame } from "./scene";

/** A light on top of a crate that's being worked on or landing. */
function addWorkLight(frame: Frame, out: PrimList, p: Payload) {
  const { pal, reduced, time } = frame;
  const { cam } = out;
  const top = project(cam, { x: p.pos.x, y: p.pos.y, z: p.pos.z + BOX.h + 0.14 });
  let phase = 0;
  for (let i = 0; i < p.id.length; i++) phase += p.id.charCodeAt(i);
  const pulse = reduced ? 0.8 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(time * 4.2 + phase));
  out.prims.push({
    kind: "glow",
    z: top.z - 0.3,
    p: top,
    r: Math.max(5, (0.55 * cam.scale) / top.z),
    color: p.zone === "working" ? pal.live : pal.ok,
    alpha: pulse,
  });
}

export function addCrates(frame: Frame, out: PrimList) {
  const { pal, model, live } = frame;
  for (const p of model.payloads.values()) {
    if (!p.carried && !p.leaving && model.slotOf(p) >= CAPACITY) continue;
    const g = easeInOut(p.grow);
    if (g <= 0.01) continue;
    const rgb = mix(pal.crate[p.paintFrom], pal.crate[p.zone], easeInOut(p.paint));
    box(out, { at: p.pos, w: BOX.w * g, d: BOX.w * g, h: BOX.h * g, yaw: p.yaw, rgb, id: p.id, edge: 0.84, lid: true });
    const lit = !p.carried && (p.zone === "working" || p.zone === "merging") && live && g > 0.9;
    if (lit) addWorkLight(frame, out, p);
  }
}
