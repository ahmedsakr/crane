import { useNavigate } from "react-router-dom";
import type { Task } from "@crane/contracts";
import { api, choosableDrivers, type DriverInfo } from "../../lib/api";
import type { TaskActions } from "./task-actions";

/** What can still be done with the task from the rail: change or cancel it while it's pending, or run it again. */
export function RetryActions({ task, inGoal, drivers, usedDriver, onChangeAgent, actions }: {
  task: Task;
  inGoal: boolean;
  drivers: DriverInfo[] | null;
  usedDriver: string | null;
  onChangeAgent: () => void;
  actions: TaskActions;
}) {
  const nav = useNavigate();
  const { busy, run } = actions;
  const openRetry = (r: unknown) => nav(`/tasks/${(r as { id: string }).id}`);
  // When it didn't work out, offer the other installed agents too.
  const otherAgents = !inGoal && ["failed", "cancelled", "rejected"].includes(task.status)
    ? choosableDrivers(drivers ?? []).filter((d) => d.name !== usedDriver)
    : [];
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {task.status === "queued" && (
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={onChangeAgent}>
          Change agent
        </button>
      )}
      {["queued", "running"].includes(task.status) && (
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => run("cancel", () => api.cancel(task.id), "Cancelled")}>
          Cancel task
        </button>
      )}
      {!inGoal && ["failed", "cancelled", "rejected", "done", "approved", "merged"].includes(task.status) && (
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => run("retry", () => api.retry(task.id), "Queued again", openRetry)}>
          Run again
        </button>
      )}
      {otherAgents.map((d) => (
        <button key={d.name} className="btn btn-quiet btn-sm" disabled={busy}
          onClick={() => run("retry", () => api.retry(task.id, d.name), `Queued again on ${d.label}`, openRetry)}>
          Run again on {d.label}
        </button>
      ))}
    </div>
  );
}
