import { useEffect, useMemo, useState } from "react";
import { ACTIVE_STATUSES, type TaskDetail, type TaskEvent } from "../../lib/api";
import { useEventStream } from "../../lib/hooks";
import { addLiveEvent, uniqueEvents } from "./task-view";

const EMPTY_EVENTS: TaskEvent[] = [];

/** Confirmed history followed by anything streamed since while the task is active. */
export function useTaskEvents(id: string, data: TaskDetail | null): TaskEvent[] {
  const [live, setLive] = useState<TaskEvent[]>([]);
  const current = data?.task.id === id ? data : null;
  const polled = current?.events ?? EMPTY_EVENTS;
  const lastId = polled.at(-1)?.id ?? 0;
  useEffect(() => setLive((events) => events.filter((event) => event.taskId === id && event.id > lastId)), [id, lastId]);
  useEventStream(current && ACTIVE_STATUSES.includes(current.task.status) ? id : null, (e) => setLive((l) => addLiveEvent(l, e)), lastId);
  return useMemo(() => uniqueEvents(polled, live.filter((event) => event.taskId === id && event.id > lastId)), [polled, id, lastId, live]);
}
