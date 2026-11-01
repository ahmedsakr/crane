import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { STATUS_LABEL, type Overview, type Task } from "../lib/api";
import { plural } from "../lib/format";
import { ZONE_IDS, ZONE_LABEL, ZONE_OF, type ZoneId } from "../lib/site";
import { SiteView } from "./site-view";

/**
 * Home's construction site: a tower crane carries each task, as a crate, from
 * Queued to Working to Needs you to Merging, and on to Shipped or Didn't ship,
 * as its status changes. Point at a crate to see the task; tap it to open it.
 * The legend counts what's drawn, so it changes when a crate is set down; the
 * accessible label counts statuses.
 */
export function Site({ o }: { o: Overview }) {
  const nav = useNavigate();
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<SiteView | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drawn, setDrawn] = useState<Record<ZoneId, number> | null>(null);
  const navRef = useRef(nav);
  navRef.current = nav;

  const tasks = useMemo(() => {
    const seen = new Map<string, Task>();
    for (const t of [...o.inFlight, ...o.needsReview, ...o.recent]) if (!seen.has(t.id)) seen.set(t.id, t);
    return [...seen.values()];
  }, [o.inFlight, o.needsReview, o.recent]);
  const live = o.factory.running && !o.factory.paused;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const v = new SiteView(el, {
      hover: (id, x, y) => setTip(id ? { id, x, y } : null),
      open: (id) => navRef.current(`/tasks/${id}`),
      counts: setDrawn,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.update(tasks, live);
  }, [tasks, live]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(ZONE_IDS.map((z) => [z, 0])) as Record<ZoneId, number>;
    for (const t of tasks) c[ZONE_OF[t.status]]++;
    return c;
  }, [tasks]);
  const summary = ZONE_IDS.filter((z) => counts[z])
    .map((z) => `${ZONE_LABEL[z]}: ${counts[z]}`)
    .join(", ");

  const hovered = tip ? tasks.find((t) => t.id === tip.id) : undefined;
  const repo = hovered ? o.repos.find((r) => r.id === hovered.repoId)?.name : undefined;

  return (
    <div className="card site">
      <canvas
        ref={canvas}
        className="site-canvas"
        role="img"
        aria-label={`Construction site with ${plural(tasks.length, "task")} as crates. ${summary || "Nothing on site yet."}`}
      />
      {hovered && tip && (
        <div
          className={`site-tip ${tip.y < 90 ? "below" : ""}`}
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          <span className="site-tip-title">{hovered.title}</span>
          <span className="site-tip-meta">{[STATUS_LABEL[hovered.status], repo].filter(Boolean).join(" · ")}</span>
        </div>
      )}
      <ul className="site-legend" aria-hidden="true">
        {ZONE_IDS.map((z) => (
          <li key={z}>
            <span className={`site-swatch site-swatch-${z}`} />
            {ZONE_LABEL[z]} <b>{(drawn ?? counts)[z]}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
