import { api } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { mergeTaskDetail, type TaskDetailWithHistory } from "./task-view";

export function useTaskDetail(id: string) {
  const poll = usePoll<TaskDetailWithHistory>(async (): Promise<TaskDetailWithHistory> => {
    const previous = poll.data?.task.id === id ? poll.data : null;
    // Only confirmed polls advance this cursor. The live stream can replay or arrive ahead of a poll.
    const after = previous ? (previous.events.at(-1)?.id ?? 0) : undefined;
    return mergeTaskDetail(previous, await api.task(id, after));
  }, 3000, [id]);
  return poll;
}
