import { useEffect, useMemo, useState } from "react";
import { ACTIVE_STATUSES, type TaskDetail, type TaskEvent } from "../../lib/api";
import { useEventStream } from "../../lib/hooks";
import { addLiveEvent, uniqueEvents } from "./task-view";

/** The task's events: what the last poll returned, then anything streamed since while it's active. */
export function useTaskEvents(id: string, data: TaskDetail | null): TaskEvent[] {
  const [live, setLive] = useState<TaskEvent[]>([]);
  const lastId = data?.events.at(-1)?.id ?? 0;
  useEffect(() => setLive([]), [lastId]);
  useEventStream(data && ACTIVE_STATUSES.includes(data.task.status) ? id : null, (e) => setLive((l) => addLiveEvent(l, e)), lastId);
  return useMemo(() => uniqueEvents(data?.events ?? [], live), [data, live]);
}
