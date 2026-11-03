import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { api, type Task } from "../lib/api";
import { TaskRow } from "./bits";

type Drag = { id: string; pointer: number; startY: number; y: number; moved: boolean; beforeId: string | null };
type Drop = { id: string; beforeId: string | null };

/** A separate queue keeps the full pickup order visible even beyond the task-list limit. */
export function TaskQueue({ repoName, instruct }: { repoName: (id: string | null) => string | undefined; instruct: () => void }) {
  const [queue, setQueue] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [drop, setDrop] = useState<Drop | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const helpId = useId();

  // Ignore polls that began before a drag or save, and freeze rows during either.
  const refresh = useCallback(async () => {
    if (busy.current || drag.current) return;
    const version = ++revision.current;
    try {
      const tasks = await api.queue();
      if (mounted.current && version === revision.current) {
        setQueue(tasks);
        setError(null);
      }
    } catch (e) {
      if (mounted.current && version === revision.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2500);
    return () => {
      mounted.current = false;
      revision.current++;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const cancel = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setDrop(null);
    setMessage("Reorder cancelled.");
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel]);

  const updateDrop = useCallback(() => {
    const d = drag.current;
    if (!d?.moved || !list.current) return;
    const rows = [...list.current.querySelectorAll<HTMLElement>("[data-queue-id]")];
    const before = rows.find(row => {
      if (row.dataset.queueId === d.id) return false;
      const rect = row.getBoundingClientRect();
      return d.y < rect.top + rect.height / 2;
    });
    d.beforeId = before?.dataset.queueId ?? null;
    setDrop(prev => prev?.id === d.id && prev.beforeId === d.beforeId ? prev : { id: d.id, beforeId: d.beforeId });
  }, []);

  // Keep scrolling while a held mouse, pen or finger reaches the viewport edge.
  useEffect(() => {
    if (!drop) return;
    let frame: number;
    const tick = () => {
      const d = drag.current;
      if (!d) return;
      const edge = 72;
      const speed = d.y < edge ? -Math.min(16, (edge - d.y) / 4)
        : d.y > window.innerHeight - edge ? Math.min(16, (d.y - window.innerHeight + edge) / 4) : 0;
      if (speed) {
        window.scrollBy(0, speed);
        updateDrop();
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [!!drop, updateDrop]);

  async function move(id: string, beforeId: string | null) {
    if (busy.current || !queue) return;
    const from = queue.findIndex(t => t.id === id);
    if (from < 0 || beforeId === id) return;
    const next = queue.filter(t => t.id !== id);
    const to = beforeId === null ? next.length : next.findIndex(t => t.id === beforeId);
    if (to < 0 || from === to) return;
    next.splice(to, 0, queue[from]);
    busy.current = true;
    revision.current++;
    setSaving(true);
    setQueue(next);
    setMoveError(null);
    setMessage("Saving queue order…");
    try {
      const saved = await api.moveQueuedTask(id, beforeId);
      if (mounted.current) {
        setQueue(saved);
        setMessage(`Moved ${queue[from].title} to position ${saved.findIndex(t => t.id === id) + 1}.`);
      }
    } catch (e) {
      if (mounted.current) {
        setQueue(queue);
        setMoveError(`Queue order wasn't saved: ${(e as Error).message}`);
        setMessage("");
      }
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
      // A failed move may mean the task or its anchor was just picked up.
      void refresh();
    }
  }

  function pointerDown(e: PointerEvent<HTMLButtonElement>, id: string) {
    if (e.button !== 0 || !e.isPrimary || busy.current || drag.current || !queue || queue.length < 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    revision.current++;
    drag.current = { id, pointer: e.pointerId, startY: e.clientY, y: e.clientY, moved: false, beforeId: id };
  }

  function pointerMove(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    d.y = e.clientY;
    if (Math.abs(d.y - d.startY) > 4) d.moved = true;
    updateDrop();
  }

  function pointerUp(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setDrop(null);
    if (d.moved) void move(d.id, d.beforeId);
  }

  return (
    <section className="task-queue" aria-label="Queue" aria-busy={saving}>
      <h2 className="section-title">Queue{queue ? ` · ${queue.length}` : ""}</h2>
      <p className="muted queue-help" id={helpId}>
        Drag a handle to change pickup order, or focus it and use ↑ / ↓. Start times, prerequisites and crew assignments still apply.
      </p>
      {error && <p className="queue-error" role="alert">{error} <button className="btn btn-quiet btn-sm" onClick={() => void refresh()}>Refresh queue</button></p>}
      {moveError && <p className="queue-error" role="alert">{moveError}</p>}
      <p className="sr-only" role="status">{message}</p>
      {!queue ? (!error && <p className="muted">Loading queue…</p>) : queue.length ? (
        <ul ref={list} className={`rows card queue-list${drop?.beforeId === null ? " queue-drop-end" : ""}`}>
          {queue.map((m, i) => (
            <TaskRow key={m.id} m={m} repoName={repoName(m.repoId)} reorder={{
              props: { className: `queue-item${drop?.id === m.id ? " queue-dragging" : ""}${drop?.beforeId === m.id ? " queue-drop-before" : ""}` },
              handle: (
                <button className="queue-handle" type="button" aria-label={`Reorder ${m.title}, position ${i + 1} of ${queue.length}`}
                  aria-describedby={helpId} aria-disabled={saving || queue.length < 2} aria-keyshortcuts="ArrowUp ArrowDown Home End"
                  title="Drag to reorder, or use the up and down arrow keys"
                  onPointerDown={e => pointerDown(e, m.id)} onPointerMove={pointerMove} onPointerUp={pointerUp}
                  onPointerCancel={cancel} onLostPointerCapture={cancel}
                  onKeyDown={e => {
                    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
                    e.preventDefault();
                    if (busy.current || drag.current) return;
                    if (e.key === "ArrowUp" && i > 0) void move(m.id, queue[i - 1].id);
                    if (e.key === "ArrowDown" && i < queue.length - 1) void move(m.id, queue[i + 2]?.id ?? null);
                    if (e.key === "Home") void move(m.id, queue[0].id);
                    if (e.key === "End") void move(m.id, null);
                  }}>
                  <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
                    {[5, 10, 15].map(y => <g key={y}><circle cx="5" cy={y} r="1.3" /><circle cx="11" cy={y} r="1.3" /></g>)}
                  </svg>
                  <span className="queue-position" aria-hidden="true">{i + 1}</span>
                </button>
              ),
            }} />
          ))}
        </ul>
      ) : (
        <div className="empty"><strong>No tasks queued</strong><button className="btn btn-primary" onClick={instruct}>Start a task</button></div>
      )}
    </section>
  );
}
