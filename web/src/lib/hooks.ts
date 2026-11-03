import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DriverInfo, type TaskEvent } from "./api";
import { createPollRequest } from "./poll";

/**
 * The agents tasks can run on, and the default. Fetched once per mount:
 * checking what's installed is slow, and it rarely changes. `set` takes the
 * list a change returned.
 */
export function useDrivers() {
  const [drivers, set] = useState<DriverInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .drivers()
      .then((d) => live && set(d))
      .catch(() => live && set([]));
    return () => {
      live = false;
    };
  }, []);
  return { drivers, set };
}

/** Fetch now, then keep it fresh. Pauses while the tab is hidden. */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 2000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request] = useState(() => createPollRequest<T>(setData, setError));
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refresh = useCallback(() => request.refresh(fetchRef.current), [request]);

  useEffect(() => {
    setData(null);
    setError(null);
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);
    return () => {
      clearInterval(t);
      request.invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, request, ...deps]);

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
