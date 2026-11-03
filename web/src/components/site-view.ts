/**
 * Draws the construction site from lib/site.ts on a 2D canvas: flat-shaded
 * boxes and lattice lines in perspective, sorted back to front. No 3D library;
 * the scene is a few hundred polygons. Colours come from the CSS tokens, so it
 * follows light and dark mode, and the crane goes graphite when the factory is
 * off, like the slab.
 *
 * It only animates while something moves (or, when the factory is running, at
 * a gentle 30 fps for the work lights), stops while scrolled out of view, and
 * holds still for reduced motion.
 */
import type { TaskSummary } from "../lib/api";
import {
  BOX,
  CAPACITY,
  COUNTER_LEN,
  JIB_LEN,
  JIB_Z,
  PAD,
  SiteModel,
  ZONE_IDS,
  dot,
  fit,
  inPolygon,
  norm,
  orbit,
  project,
  zonePoint,
  type Camera,
  type Vec3,
  type ZoneId,
} from "../lib/site";

type RGB = [number, number, number];
type Pt = { x: number; y: number; z: number };
type Prim =
  | { kind: "poly"; z: number; pts: Pt[]; fill: string; edge: string; id?: string }
  | { kind: "line"; z: number; a: Pt; b: Pt; color: string; width: number }
  | { kind: "glow"; z: number; p: Pt; r: number; color: RGB; alpha: number };

interface Palette {
  ground: RGB;
  groundSide: RGB;
  pad: RGB;
  padReview: RGB;
  padReviewEdge: RGB;
  steel: RGB;
  steelOff: RGB;
  cab: RGB;
  weight: RGB;
  crate: Record<ZoneId, RGB>;
  live: RGB;
  ok: RGB;
  text: RGB;
  textStrong: RGB;
  shadow: number;
  font: string;
}

export interface SiteViewEvents {
  /** The crate under the pointer changed or moved; null when there's none. */
  hover: (id: string | null, x: number, y: number) => void;
  open: (id: string) => void;
  /** Crates resting in each area changed, so the legend can match what's drawn. */
  counts: (counts: Record<ZoneId, number>) => void;
}

const AZIMUTH = -Math.PI / 2 - 0.08;
const ELEVATION = 0.38;
const DISTANCE = 44;
const SWAY = 0.05;
const TARGET: Vec3 = { x: 0, y: -2.6, z: 2.4 };
const LIGHT = norm({ x: -0.5, y: -0.8, z: 1.2 });
/** Where shadows fall, per unit of height. */
const SHADOW = { x: 0.32, y: 0.26 };
const GROUND = { cx: 0, cy: -2.2, rx: 12.3, ry: 6.2, depth: 0.45 };
const APEX_Z = JIB_Z + 1.9;
const TAU = Math.PI * 2;

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const css = (c: RGB, a = 1) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${a})`;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const easeInOut = (t: number) => t * t * (3 - 2 * t);

export class SiteView {
  private ctx: CanvasRenderingContext2D;
  private model = new SiteModel();
  private pal!: Palette;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cam!: Camera;
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private time = 0;
  private dirty = true;
  private live = false;
  private reduced = false;
  private visible = true;
  private countKey = "";
  private hits: { id: string; pts: Pt[] }[] = [];
  private hovered: string | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private on: SiteViewEvents,
  ) {
    this.ctx = canvas.getContext("2d")!;

    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const onMotion = () => {
      this.reduced = motion.matches;
      this.model.instant = this.reduced;
      this.requestDraw();
    };
    const onScheme = () => {
      this.readPalette();
      this.requestDraw();
    };
    onMotion();
    this.readPalette();
    motion.addEventListener("change", onMotion);
    scheme.addEventListener("change", onScheme);
    this.cleanup.push(() => motion.removeEventListener("change", onMotion));
    this.cleanup.push(() => scheme.removeEventListener("change", onScheme));
    document.fonts?.ready.then(() => this.requestDraw());

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.cleanup.push(() => ro.disconnect());

    const io = new IntersectionObserver(([e]) => {
      this.visible = !!e?.isIntersecting;
      if (this.visible) this.requestDraw();
    });
    io.observe(canvas);
    this.cleanup.push(() => io.disconnect());

    const at = (e: PointerEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const move = (e: PointerEvent) => {
      const { x, y } = at(e);
      const id = this.hit(x, y);
      if (id !== this.hovered) {
        this.hovered = id;
        canvas.style.cursor = id ? "pointer" : "";
        this.requestDraw();
      }
      this.on.hover(id, x, y);
    };
    const leave = () => {
      if (!this.hovered) return;
      this.hovered = null;
      canvas.style.cursor = "";
      this.on.hover(null, 0, 0);
      this.requestDraw();
    };
    const click = (e: MouseEvent) => {
      const { x, y } = at(e);
      const id = this.hit(x, y);
      if (id) this.on.open(id);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("click", click);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("click", click);
    });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const f of this.cleanup) f();
  }

  /** Feed the site the tasks it should show and whether the factory is running. */
  update(tasks: TaskSummary[], live: boolean) {
    this.model.sync(tasks);
    this.live = live;
    this.requestDraw();
  }

  private get ambient() {
    return this.live && !this.reduced;
  }

  private requestDraw() {
    this.dirty = true;
    if (!this.raf && this.visible && this.w) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.model.step(dt);
    if (!this.reduced) this.time += dt;
    const busy = this.model.busy;
    if (busy || this.dirty || now - this.lastDraw >= 33) {
      this.draw();
      this.lastDraw = now;
      this.dirty = false;
    }
    if ((busy || this.ambient) && this.visible) this.raf = requestAnimationFrame(this.tick);
    else this.last = 0;
  };

  private readPalette() {
    const cs = getComputedStyle(this.canvas);
    const v = (name: string) => this.rgb(cs.getPropertyValue(name).trim() || "#888");
    const concrete = v("--concrete");
    const surface = v("--surface");
    const ink = v("--ink");
    const graphite = v("--graphite");
    const ok = v("--ok");
    const live = v("--live");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    this.pal = {
      ground: concrete,
      groundSide: mix(concrete, ink, dark ? 0.1 : 0.13),
      pad: mix(concrete, ink, dark ? 0.07 : 0.055),
      padReview: v("--crane-soft"),
      padReviewEdge: v("--crane"),
      steel: ink,
      steelOff: graphite,
      cab: v("--ink-2"),
      weight: mix(graphite, concrete, 0.2),
      crate: {
        queued: mix(graphite, surface, 0.5),
        working: live,
        review: v("--crane"),
        merging: mix(ok, surface, 0.45),
        shipped: ok,
        stopped: v("--bad"),
      },
      live,
      ok,
      text: graphite,
      textStrong: ink,
      shadow: dark ? 0.42 : 0.13,
      font: getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim() || "sans-serif",
    };
  }

  /** Any CSS colour as RGB, normalised by the canvas itself. */
  private rgb(value: string): RGB {
    const ctx = this.ctx;
    ctx.fillStyle = "#000";
    ctx.fillStyle = value;
    const s = String(ctx.fillStyle);
    if (s.startsWith("#")) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    const m = s.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128];
    return [m[0] ?? 128, m[1] ?? 128, m[2] ?? 128];
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);

    // Fit everything the crane can reach, in any position, plus the ground.
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
    const base = orbit(TARGET, AZIMUTH, ELEVATION, DISTANCE);
    const fitted = fit(base, pts, w, h, 10);
    // Leave room for the camera's sway.
    const s = fitted.scale * (1 - SWAY * 0.6);
    this.cam = { ...fitted, scale: s, cx: w / 2 + (fitted.cx - w / 2) * (s / fitted.scale), cy: h / 2 + (fitted.cy - h / 2) * (s / fitted.scale) };
    this.requestDraw();
  }

  private hit(x: number, y: number): string | null {
    for (let i = this.hits.length - 1; i >= 0; i--) if (inPolygon(x, y, this.hits[i]!.pts)) return this.hits[i]!.id;
    return null;
  }

  // ── drawing ─────────────────────────────────────────────

  private draw() {
    const { ctx, w, h, pal } = this;
    if (!w || !this.cam) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const sway = this.ambient ? Math.sin((this.time * TAU) / 70) * SWAY : 0;
    const cam: Camera = { ...orbit(TARGET, AZIMUTH + sway, ELEVATION, DISTANCE), scale: this.cam.scale, cx: this.cam.cx, cy: this.cam.cy };

    const ground = this.drawGround(cam);
    this.drawPads(cam);
    // Shadows fall on the ground only.
    ctx.save();
    ctx.beginPath();
    ground.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.clip();
    this.drawShadows(cam);
    ctx.restore();

    const prims: Prim[] = [];
    this.crates(cam, prims);
    this.crane(cam, prims);
    prims.sort((a, b) => b.z - a.z);
    this.hits = [];
    for (const p of prims) {
      if (p.kind === "poly") {
        this.polygon(p.pts, p.fill, p.edge, 0.8);
        if (p.id) this.hits.push({ id: p.id, pts: p.pts });
      } else if (p.kind === "line") {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.moveTo(p.a.x, p.a.y);
        ctx.lineTo(p.b.x, p.b.y);
        ctx.stroke();
      } else {
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
    }

    if (this.hovered) {
      ctx.strokeStyle = css(pal.textStrong);
      ctx.lineWidth = 1.6;
      for (const hit of this.hits) if (hit.id === this.hovered) this.polygon(hit.pts, null, null, 0, true);
    }

    this.drawCounts(cam);
  }

  private polygon(pts: Pt[], fill: string | null, edge: string | null, width: number, strokeOnly = false) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    if (strokeOnly) {
      ctx.stroke();
      return;
    }
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

  /** The site's ground, a shallow elliptical slab. Returns its top outline on screen. */
  private drawGround(cam: Camera): Pt[] {
    const { pal } = this;
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
      this.polygon([project(cam, a.p), project(cam, b.p), below(b.p), below(a.p)], fill, fill, 0.8);
    }
    this.polygon(top, css(pal.ground), css(mix(pal.ground, pal.groundSide, 0.6)), 1);
    return top;
  }

  private drawPads(cam: Camera) {
    const { ctx, pal } = this;
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
      this.polygon(pts, fill, fill, 5);
      if (review) {
        ctx.strokeStyle = css(pal.padReviewEdge);
        ctx.lineWidth = 1.5;
        this.polygon(pts, null, null, 0, true);
      }
    }
  }

  /** Soft shadows on the ground: crates, the mast, and the jib, which shows which way the crane is turned. */
  private drawShadows(cam: Camera) {
    const { ctx, pal, model } = this;
    const onGround = (p: Vec3, z = p.z): Pt => project(cam, { x: p.x + SHADOW.x * z, y: p.y + SHADOW.y * z, z: 0.004 });
    const band = (a: Vec3, b: Vec3, width: number, alpha: number) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const ox = (-dy / l) * (width / 2);
      const oy = (dx / l) * (width / 2);
      const pts = [
        onGround({ x: a.x + ox, y: a.y + oy, z: a.z }),
        onGround({ x: b.x + ox, y: b.y + oy, z: b.z }),
        onGround({ x: b.x - ox, y: b.y - oy, z: b.z }),
        onGround({ x: a.x - ox, y: a.y - oy, z: a.z }),
      ];
      ctx.fillStyle = `rgb(0 0 0 / ${alpha})`;
      this.polygon(pts, ctx.fillStyle, null, 0);
    };
    const { theta, r } = model.rig;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    band({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: JIB_Z }, 0.8, pal.shadow * 0.55);
    band({ x: c * 0.5, y: s * 0.5, z: JIB_Z }, { x: c * JIB_LEN, y: s * JIB_LEN, z: JIB_Z }, 0.55, pal.shadow * 0.45);
    band({ x: -c * 0.5, y: -s * 0.5, z: JIB_Z }, { x: -c * COUNTER_LEN, y: -s * COUNTER_LEN, z: JIB_Z }, 0.8, pal.shadow * 0.5);
    band({ x: c * r, y: s * r, z: JIB_Z }, { x: c * r, y: s * r, z: model.rig.hookZ }, 0.08, pal.shadow * 0.5);

    for (const p of model.payloads.values()) {
      if (!p.carried && (p.pos.z > 0.05 || model.slotOf(p) >= CAPACITY)) continue;
      const g = easeInOut(p.grow);
      const w = (BOX.w * g) / 2 + 0.06;
      const cy = Math.cos(p.yaw);
      const sy = Math.sin(p.yaw);
      const corner = (i: number, j: number) => onGround({ x: p.pos.x + (i * cy - j * sy) * w, y: p.pos.y + (i * sy + j * cy) * w, z: p.pos.z }, p.pos.z);
      const alpha = pal.shadow * (p.carried ? Math.max(0.3, 1 - p.pos.z / 9) : 1);
      ctx.fillStyle = `rgb(0 0 0 / ${alpha})`;
      this.polygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], ctx.fillStyle, null, 0);
    }
  }

  private line(cam: Camera, prims: Prim[], a: Vec3, b: Vec3, width: number, color: string) {
    const pa = project(cam, a);
    const pb = project(cam, b);
    const z = (pa.z + pb.z) / 2;
    prims.push({ kind: "line", z, a: pa, b: pb, color, width: Math.max(0.7, (width * cam.scale) / z) });
  }

  /**
   * A flat-shaded box standing on `c`, `w` long along `yaw` and `d` across.
   * `lid` draws a crate's lid seam on its sides.
   */
  private box(
    cam: Camera,
    prims: Prim[],
    c: Vec3,
    w: number,
    d: number,
    h: number,
    yaw: number,
    rgb: RGB,
    opts: { id?: string; edge?: number; lid?: boolean } = {},
  ) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const corner = (i: number, j: number, k: number): Vec3 => ({
      x: c.x + (i * cy * w) / 2 - (j * sy * d) / 2,
      y: c.y + (i * sy * w) / 2 + (j * cy * d) / 2,
      z: c.z + k * h,
    });
    const faces: { n: Vec3; v: [number, number, number][] }[] = [
      { n: { x: 0, y: 0, z: 1 }, v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
      { n: { x: cy, y: sy, z: 0 }, v: [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]] },
      { n: { x: -cy, y: -sy, z: 0 }, v: [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]] },
      { n: { x: -sy, y: cy, z: 0 }, v: [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]] },
      { n: { x: sy, y: -cy, z: 0 }, v: [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]] },
    ];
    for (const f of faces) {
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
      prims.push({ kind: "poly", z, pts, fill: css(fill), edge: css(opts.edge ? shade(fill, opts.edge) : fill), id: opts.id });
      if (opts.lid && f.n.z === 0) {
        const at = (a: Vec3, b: Vec3, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        const pa = project(cam, at(world[0]!, world[3]!, 0.76));
        const pb = project(cam, at(world[1]!, world[2]!, 0.76));
        prims.push({ kind: "line", z: z - 0.001, a: pa, b: pb, color: css(shade(fill, 0.82)), width: 1 });
      }
    }
  }

  private crates(cam: Camera, prims: Prim[]) {
    const { pal, model } = this;
    for (const p of model.payloads.values()) {
      if (!p.carried && !p.leaving && model.slotOf(p) >= CAPACITY) continue;
      const g = easeInOut(p.grow);
      if (g <= 0.01) continue;
      const color = mix(pal.crate[p.paintFrom], pal.crate[p.zone], easeInOut(p.paint));
      this.box(cam, prims, p.pos, BOX.w * g, BOX.w * g, BOX.h * g, p.yaw, color, { id: p.id, edge: 0.84, lid: true });

      // Work lights on crates that are being worked on or landing.
      const lit = !p.carried && (p.zone === "working" || p.zone === "merging") && this.live && g > 0.9;
      if (lit) {
        const top = project(cam, { x: p.pos.x, y: p.pos.y, z: p.pos.z + BOX.h + 0.14 });
        let phase = 0;
        for (let i = 0; i < p.id.length; i++) phase += p.id.charCodeAt(i);
        const pulse = this.reduced ? 0.8 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * 4.2 + phase));
        prims.push({
          kind: "glow",
          z: top.z - 0.3,
          p: top,
          r: Math.max(5, (0.55 * cam.scale) / top.z),
          color: p.zone === "working" ? pal.live : pal.ok,
          alpha: pulse,
        });
      }
    }
  }

  private crane(cam: Camera, prims: Prim[]) {
    const { pal, model } = this;
    const steelRgb = this.live ? pal.steel : pal.steelOff;
    const steel = css(steelRgb);
    const thin = css(steelRgb, 0.75);
    const { theta, r, hookZ } = model.rig;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Along the jib (u) and across it (v).
    const J = (u: number, v: number, z: number): Vec3 => ({ x: u * c - v * s, y: u * s + v * c, z });

    // Footing and mast.
    this.box(cam, prims, { x: 0, y: 0, z: 0 }, 1.7, 1.7, 0.28, 0, pal.groundSide);
    const m = 0.4;
    const posts: [number, number][] = [
      [-m, -m],
      [m, -m],
      [m, m],
      [-m, m],
    ];
    const mastTop = JIB_Z - 0.55;
    const bays = 8;
    const bay = (mastTop - 0.28) / bays;
    for (let k = 0; k < bays; k++) {
      const z0 = 0.28 + k * bay;
      const z1 = z0 + bay;
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = posts[i]!;
        const [bx, by] = posts[(i + 1) % 4]!;
        this.line(cam, prims, { x: ax, y: ay, z: z0 }, { x: ax, y: ay, z: z1 }, 0.07, steel);
        this.line(cam, prims, { x: ax, y: ay, z: z1 }, { x: bx, y: by, z: z1 }, 0.04, thin);
        if (k % 2) this.line(cam, prims, { x: ax, y: ay, z: z0 }, { x: bx, y: by, z: z1 }, 0.035, thin);
        else this.line(cam, prims, { x: bx, y: by, z: z0 }, { x: ax, y: ay, z: z1 }, 0.035, thin);
      }
    }

    // Slewing unit and cab turn with the jib.
    this.box(cam, prims, { x: 0, y: 0, z: mastTop }, 1.0, 1.0, 0.55, theta, steelRgb);
    this.box(cam, prims, J(0.15, 0.78, JIB_Z - 0.85), 0.75, 0.6, 0.62, theta, pal.cab, { edge: 0.8 });

    // Jib: a triangular truss that tapers to the tip.
    const half = 0.32;
    const topAt = (u: number) => (u < JIB_LEN - 2 ? 0.7 : 0.7 - (0.55 * (u - (JIB_LEN - 2))) / 2);
    const step = 0.9;
    let u0 = 0.5;
    while (u0 < JIB_LEN - 0.01) {
      const u1 = Math.min(JIB_LEN, u0 + step);
      const t0 = J(u0, 0, JIB_Z + topAt(u0));
      const t1 = J(u1, 0, JIB_Z + topAt(u1));
      for (const v of [-half, half]) {
        this.line(cam, prims, J(u0, v, JIB_Z), J(u1, v, JIB_Z), 0.06, steel);
        this.line(cam, prims, J(u0, v, JIB_Z), t1, 0.03, thin);
        this.line(cam, prims, J(u1, v, JIB_Z), t1, 0.03, thin);
      }
      this.line(cam, prims, t0, t1, 0.05, steel);
      this.line(cam, prims, J(u1, -half, JIB_Z), J(u1, half, JIB_Z), 0.03, thin);
      u0 = u1;
    }

    // Counter-jib with its counterweight.
    let c0 = -0.5;
    while (c0 > -COUNTER_LEN + 0.01) {
      const c1 = Math.max(-COUNTER_LEN, c0 - step);
      for (const v of [-0.4, 0.4]) this.line(cam, prims, J(c0, v, JIB_Z), J(c1, v, JIB_Z), 0.06, steel);
      this.line(cam, prims, J(c1, -0.4, JIB_Z), J(c1, 0.4, JIB_Z), 0.03, thin);
      this.line(cam, prims, J(c0, -0.4, JIB_Z), J(c1, 0.4, JIB_Z), 0.03, thin);
      c0 = c1;
    }
    this.box(cam, prims, J(-COUNTER_LEN + 0.65, 0, JIB_Z - 0.75), 1.1, 0.95, 0.85, theta, pal.weight, { edge: 0.85 });

    // Tower top and the pendant lines that hold up the jibs.
    const apex = { x: 0, y: 0, z: APEX_Z };
    for (const [u, v] of [
      [0.45, 0.45],
      [0.45, -0.45],
      [-0.45, 0.45],
      [-0.45, -0.45],
    ] as const)
      this.line(cam, prims, J(u, v, JIB_Z), apex, 0.06, steel);
    this.line(cam, prims, apex, J(JIB_LEN * 0.55, 0, JIB_Z + topAt(JIB_LEN * 0.55)), 0.025, thin);
    this.line(cam, prims, apex, J(JIB_LEN - 0.4, 0, JIB_Z + topAt(JIB_LEN - 0.4)), 0.025, thin);
    for (const v of [-0.4, 0.4]) this.line(cam, prims, apex, J(-COUNTER_LEN, v, JIB_Z), 0.025, thin);

    // Trolley, hoist cables, hook block.
    this.box(cam, prims, J(r, 0, JIB_Z - 0.22), 0.6, 0.78, 0.22, theta, steelRgb);
    for (const v of [-0.1, 0.1]) this.line(cam, prims, J(r, v, JIB_Z - 0.22), J(r, v, hookZ + 0.3), 0.022, steel);
    this.box(cam, prims, J(r, 0, hookZ), 0.34, 0.3, 0.3, theta, steelRgb);

    // Slings down to the crate on the hook.
    const load = model.job ? model.payloads.get(model.job.id) : undefined;
    if (load?.carried) {
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
        this.line(cam, prims, hook, { x: load.pos.x + (i * cy - j * sy) * hw, y: load.pos.y + (i * sy + j * cy) * hw, z }, 0.018, thin);
    }
  }

  /** Each area's crate count in front of its pad; the legend under the drawing names them. */
  private drawCounts(cam: Camera) {
    const { ctx, pal, model } = this;
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
    const key = ZONE_IDS.map((z) => counts[z]).join();
    if (key !== this.countKey) {
      this.countKey = key;
      this.on.counts(counts);
    }
  }
}
