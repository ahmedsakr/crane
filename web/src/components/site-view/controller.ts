/**
 * Runs the site's canvas: it owns the browser wiring and the frame loop, and
 * hands each frame to the painters.
 *
 * It only animates while something moves (or, when the factory is running, at
 * a gentle 30 fps for the work lights), stops while scrolled out of view, and
 * holds still for reduced motion.
 */
import type { TaskSummary } from "../../lib/api";
import { SiteModel, ZONE_IDS, inPolygon, type Camera, type ZoneId } from "../../lib/site";
import { paintSite, type Hit } from "./painter";
import { readPalette, type Palette } from "./palette";
import { fitSiteCamera, frameCamera } from "./scene";

export interface SiteViewEvents {
  /** The crate under the pointer changed or moved; null when there's none. */
  hover: (id: string | null, x: number, y: number) => void;
  open: (id: string) => void;
  /** Crates resting in each area changed, so the legend can match what's drawn. */
  counts: (counts: Record<ZoneId, number>) => void;
}

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
  private hits: Hit[] = [];
  private hovered: string | null = null;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private on: SiteViewEvents,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.watchPreferences();
    document.fonts?.ready.then(() => this.requestDraw());
    this.watchCanvas();
    this.watchPointer();
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

  /** Reduced motion and colour scheme, now and whenever they change. */
  private watchPreferences() {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const onMotion = () => {
      this.reduced = motion.matches;
      this.model.instant = this.reduced;
      this.requestDraw();
    };
    const onScheme = () => {
      this.pal = readPalette(this.canvas, this.ctx);
      this.requestDraw();
    };
    onMotion();
    this.pal = readPalette(this.canvas, this.ctx);
    motion.addEventListener("change", onMotion);
    scheme.addEventListener("change", onScheme);
    this.cleanup.push(() => motion.removeEventListener("change", onMotion));
    this.cleanup.push(() => scheme.removeEventListener("change", onScheme));
  }

  /** The canvas's size, and whether it's on screen. */
  private watchCanvas() {
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.canvas);
    this.cleanup.push(() => ro.disconnect());

    const io = new IntersectionObserver(([e]) => {
      this.visible = !!e?.isIntersecting;
      if (this.visible) this.requestDraw();
    });
    io.observe(this.canvas);
    this.cleanup.push(() => io.disconnect());
  }

  private watchPointer() {
    const { canvas } = this;
    const move = (e: PointerEvent) => {
      const { x, y } = this.pointerAt(e);
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
      const { x, y } = this.pointerAt(e);
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

  private pointerAt(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number): string | null {
    for (let i = this.hits.length - 1; i >= 0; i--) if (inPolygon(x, y, this.hits[i]!.pts)) return this.hits[i]!.id;
    return null;
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

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cam = fitSiteCamera(w, h);
    this.requestDraw();
  }

  private draw() {
    const { ctx, w, h, dpr, pal, model, live, reduced, time, hovered } = this;
    if (!w || !this.cam) return;
    const cam = frameCamera(this.cam, this.ambient, time);
    const { hits, counts } = paintSite({ ctx, w, h, dpr, cam, pal, model, live, reduced, time, hovered });
    this.hits = hits;
    this.reportCounts(counts);
  }

  private reportCounts(counts: Record<ZoneId, number>) {
    const key = ZONE_IDS.map((z) => counts[z]).join();
    if (key !== this.countKey) {
      this.countKey = key;
      this.on.counts(counts);
    }
  }
}
