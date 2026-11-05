import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { STATUS_LABEL, type Overview, type TaskSummary } from "../lib/api";
import { plural } from "../lib/format";
import { ZONE_IDS, ZONE_LABEL, type ZoneId } from "../lib/site";
import { siteTasks, zoneCounts, zoneSummary } from "../lib/site/summary";
import { SiteView } from "./site-view";

type Tip = { id: string; x: number; y: number };

/** Runs the canvas's view for as long as it's mounted: hands it the tasks, and reports what it draws. */
function useSiteView(canvas: RefObject<HTMLCanvasElement | null>, tasks: TaskSummary[], live: boolean) {
  const nav = useNavigate();
  const view = useRef<SiteView | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [drawn, setDrawn] = useState<Record<ZoneId, number> | null>(null);
  const navRef = useRef(nav);
  navRef.current = nav;

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
  }, [canvas]);

  useEffect(() => {
    view.current?.update(tasks, live);
  }, [tasks, live]);

  return { tip, drawn };
}

function SiteTip({ task, repo, tip }: { task: TaskSummary; repo?: string; tip: Tip }) {
  return (
    <div className={`site-tip ${tip.y < 90 ? "below" : ""}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      <span className="site-tip-title">{task.title}</span>
      <span className="site-tip-meta">{[STATUS_LABEL[task.status], repo].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/**
 * Home's construction site: a tower crane carries each task, as a crate, from
 * Queued to Working to Needs you to Merging, and on to Shipped or Didn't ship,
 * as its status changes. Point at a crate to see the task; tap it to open it.
 * The legend counts what's drawn, so it changes when a crate is set down; the
 * accessible label counts statuses.
 */
export function Site({ o }: { o: Overview }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tasks = useMemo(() => siteTasks(o), [o.inFlight, o.needsReview, o.recent]);
  const { tip, drawn } = useSiteView(canvas, tasks, o.factory.running && !o.factory.paused);
  const counts = useMemo(() => zoneCounts(tasks), [tasks]);
  const hovered = tip ? tasks.find((t) => t.id === tip.id) : undefined;
  const repo = hovered ? o.repos.find((r) => r.id === hovered.repoId)?.name : undefined;

  return (
    <div className="card site">
      <canvas
        ref={canvas}
        className="site-canvas"
        role="img"
        aria-label={`Construction site with ${plural(tasks.length, "task")} as crates. ${zoneSummary(counts) || "Nothing on site yet."}`}
      />
      {hovered && tip && <SiteTip task={hovered} repo={repo} tip={tip} />}
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
