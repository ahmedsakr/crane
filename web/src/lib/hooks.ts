import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskEvent } from "./api";

/** Fetch now, then keep it fresh. Pauses while the tab is hidden. */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 2000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      setData(await fetchRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setData(null);
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);

  return { data, error, refresh };
}

/** Subscribe to live events for a task (or "all"). */
export function useEventStream(id: string | null, onEvent: (e: TaskEvent) => void, after = 0) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/tasks/${id}/stream?after=${after}`);
    es.addEventListener("event", (msg) => cb.current(JSON.parse((msg as MessageEvent).data)));
    return () => es.close();
  }, [id, after]);
}

/** Re-render on an interval so relative times ("4m ago") stay honest. */
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
