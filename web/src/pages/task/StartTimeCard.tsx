import { isScheduled, type Task } from "@crane/contracts";
import { TaskScheduleForm } from "../../components/TaskScheduleForm";
import { api } from "../../lib/api";
import type { TaskActions } from "./task-actions";

function StartTime({ task }: { task: Task }) {
  if (!task.scheduledAt) return <>Now, once an agent is free and prerequisites are met.</>;
  return <>
    <time dateTime={task.scheduledAt}>{new Date(task.scheduledAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" })}</time>
    {!isScheduled(task) && " · Start time reached; prerequisites and agent availability still apply."}
  </>;
}

export function StartTimeCard({ task, actions }: { task: Task; actions: TaskActions }) {
  if (task.status !== "queued") return null;
  const { busy, run } = actions;
  return (
    <div className="card card-pad">
      <h3 className="card-title">Start time</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        <StartTime task={task} />
        {" The factory must be running and unpaused."}
      </p>
      {isScheduled(task) && (
        <button className="btn btn-quiet btn-sm" disabled={busy}
          onClick={() => run("schedule", () => api.schedule(task.id, null), "Start time cleared. Prerequisites still apply.")}>
          Start now
        </button>
      )}
      <TaskScheduleForm key={`${task.id}:${task.scheduledAt}`} scheduledAt={task.scheduledAt ?? null} busy={busy}
        onSave={(time) => run("schedule", () => api.schedule(task.id, time), time ? "Start time saved" : "Start time cleared. Prerequisites still apply.")} />
    </div>
  );
}
