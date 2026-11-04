/** The task list's filters. Pure: no DOM and no React. */
import type { TaskSummary } from "@crane/contracts";

export const TASK_FILTERS = [
  { key: "open", label: "Open", status: "needs_review,merging,running,queued" },
  { key: "queue", label: "Queue", status: "queued" },
  { key: "review", label: "Needs you", status: "needs_review" },
  { key: "finished", label: "Finished", status: "merged,done,approved,rejected" },
  { key: "problems", label: "Failed", status: "failed,cancelled" },
  { key: "all", label: "All", status: "" },
] as const;

export type TaskFilterKey = (typeof TASK_FILTERS)[number]["key"];

export function filterStatus(key: TaskFilterKey): string {
  return TASK_FILTERS.find((filter) => filter.key === key)!.status;
}

/** Filters that include queued work show it in the queue, in pickup order. */
export function showsQueue(key: TaskFilterKey): boolean {
  return key === "open" || key === "all" || key === "queue";
}

/** The rows for the list above the queue; undefined until the first response arrives. */
export function visibleTasks(key: TaskFilterKey, data: TaskSummary[] | null): TaskSummary[] | undefined {
  if (key === "queue") return [];
  return data?.filter((task) => !showsQueue(key) || task.status !== "queued");
}
