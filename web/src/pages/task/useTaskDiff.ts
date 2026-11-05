import { useEffect, useState } from "react";
import { api, type TaskDiff } from "../../lib/api";
import { changesFor } from "./task-view";

/**
 * A task's changes, fetched while `on`. A running task's keep changing, so with `live`
 * they refresh every few seconds while the tab is visible.
 */
export function useTaskDiff(id: string, on: boolean, live: boolean) {
  const [state, setState] = useState<{ id: string; diff: TaskDiff | null; error: string | null }>({ id, diff: null, error: null });
  useEffect(() => {
    if (!on) return;
    let current = true;
    const load = () =>
      api.diff(id).then(
        (diff) => current && setState({ id, diff, error: null }),
        (e: Error) => current && setState((s) => ({ id, diff: s.id === id ? s.diff : null, error: e.message })),
      );
    load();
    const t = live ? setInterval(() => document.visibilityState === "visible" && load(), 4000) : undefined;
    return () => {
      current = false;
      clearInterval(t);
    };
  }, [id, on, live]);
  return changesFor(state, id);
}
