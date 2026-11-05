import { errorMessage } from "@crane/contracts";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api, type TaskSummary } from "./api";
import { edgeScrollSpeed, isReorderKey, keyboardDrop, reorderedQueue, type QueueDrop } from "./queue-reorder";

const POLL_MS = 2500;
const DRAG_THRESHOLD_PX = 4;

type Drag = { id: string; pointer: number; startY: number; y: number; moved: boolean; beforeId: string | null };

/** What polling, saving and dragging share without re-rendering. */
interface QueueFlags {
  mounted: boolean;
  busy: boolean;
  revision: number;
  drag: Drag | null;
}

type Flags = { current: QueueFlags };

function useQueuePolling(flags: Flags, setQueue: (tasks: TaskSummary[]) => void, setError: (error: string | null) => void) {
  // Ignore polls that began before a drag or save, and freeze rows during either.
  const refresh = useCallback(async () => {
    const state = flags.current;
    if (state.busy || state.drag) return;
    const version = ++state.revision;
    try {
      const tasks = await api.queue();
      if (state.mounted && version === state.revision) {
        setQueue(tasks);
        setError(null);
      }
    } catch (e) {
      if (state.mounted && version === state.revision) setError(errorMessage(e));
    }
  }, [flags, setQueue, setError]);

  useEffect(() => {
    const state = flags.current;
    state.mounted = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      state.mounted = false;
      state.revision++;
      window.clearInterval(timer);
    };
  }, [flags, refresh]);

  return refresh;
}

/** The full pickup order, kept fresh, with moves saved optimistically. */
export function useTaskQueue() {
  const [queue, setQueue] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const flags = useRef<QueueFlags>({ mounted: false, busy: false, revision: 0, drag: null });
  const refresh = useQueuePolling(flags, setQueue, setError);

  async function move(id: string, beforeId: string | null) {
    const state = flags.current;
    if (state.busy || !queue) return;
    const next = reorderedQueue(queue, id, beforeId);
    if (!next) return;
    state.busy = true;
    state.revision++;
    setSaving(true);
    setQueue(next);
    setMoveError(null);
    setMessage("Saving queue order…");
    try {
      const saved = await api.moveQueuedTask(id, beforeId);
      if (state.mounted) {
        setQueue(saved);
        setMessage(`Moved ${queue.find((task) => task.id === id)!.title} to position ${saved.findIndex((task) => task.id === id) + 1}.`);
      }
    } catch (e) {
      if (state.mounted) {
        setQueue(queue);
        setMoveError(`Queue order wasn't saved: ${errorMessage(e)}`);
        setMessage("");
      }
    } finally {
      state.busy = false;
      if (state.mounted) setSaving(false);
      // A failed move may mean the task or its anchor was just picked up.
      void refresh();
    }
  }

  return { queue, error, moveError, saving, message, setMessage, flags, refresh, move };
}

type TaskQueueState = ReturnType<typeof useTaskQueue>;

function useEscapeCancels(flags: Flags, cancel: () => void) {
  useEffect(() => {
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && flags.current.drag) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [flags, cancel]);
}

/** Keep scrolling while a held mouse, pen or finger reaches the viewport edge. */
function useEdgeScroll(dropping: boolean, flags: Flags, updateDrop: () => void) {
  useEffect(() => {
    if (!dropping) return;
    let frame: number;
    const tick = () => {
      const drag = flags.current.drag;
      if (!drag) return;
      const speed = edgeScrollSpeed(drag.y, window.innerHeight);
      if (speed) {
        window.scrollBy(0, speed);
        updateDrop();
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [dropping, flags, updateDrop]);
}

/** The first row whose middle sits below the pointer, skipping the row being dragged. */
function rowBelow(list: HTMLUListElement, drag: Drag): string | null {
  const rows = [...list.querySelectorAll<HTMLElement>("[data-queue-id]")];
  const before = rows.find((row) => {
    if (row.dataset.queueId === drag.id) return false;
    const rect = row.getBoundingClientRect();
    return drag.y < rect.top + rect.height / 2;
  });
  return before?.dataset.queueId ?? null;
}

/** Drag and keyboard reordering for the queue's handles. */
export function useQueueDrag({ queue, flags, refresh, move, setMessage }: TaskQueueState) {
  const [drop, setDrop] = useState<QueueDrop | null>(null);
  const list = useRef<HTMLUListElement>(null);

  const cancel = useCallback(() => {
    if (!flags.current.drag) return;
    flags.current.drag = null;
    setDrop(null);
    setMessage("Reorder cancelled.");
    void refresh();
  }, [flags, refresh, setMessage]);

  const updateDrop = useCallback(() => {
    const drag = flags.current.drag;
    if (!drag?.moved || !list.current) return;
    const beforeId = rowBelow(list.current, drag);
    drag.beforeId = beforeId;
    setDrop((prev) => (prev?.id === drag.id && prev.beforeId === beforeId ? prev : { id: drag.id, beforeId }));
  }, [flags]);

  useEscapeCancels(flags, cancel);
  useEdgeScroll(!!drop, flags, updateDrop);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>, id: string) {
    const state = flags.current;
    if (e.button !== 0 || !e.isPrimary || state.busy || state.drag || !queue || queue.length < 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    state.revision++;
    state.drag = { id, pointer: e.pointerId, startY: e.clientY, y: e.clientY, moved: false, beforeId: id };
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const drag = flags.current.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    drag.y = e.clientY;
    if (Math.abs(drag.y - drag.startY) > DRAG_THRESHOLD_PX) drag.moved = true;
    updateDrop();
  }

  function onPointerUp(e: PointerEvent<HTMLButtonElement>) {
    const drag = flags.current.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    flags.current.drag = null;
    setDrop(null);
    if (drag.moved) void move(drag.id, drag.beforeId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number, tasks: TaskSummary[]) {
    if (!isReorderKey(e.key)) return;
    e.preventDefault();
    if (flags.current.busy || flags.current.drag) return;
    const target = keyboardDrop(e.key, index, tasks);
    if (target) void move(target.id, target.beforeId);
  }

  return { list, drop, cancel, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}

export type QueueDragControls = ReturnType<typeof useQueueDrag>;
