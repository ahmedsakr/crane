import { useState } from "react";
import { useApp } from "../lib/app-context";
import { api, type TaskSummary } from "../lib/api";
import { usePoll, useTick } from "../lib/hooks";
import { repoNamer } from "../lib/overview";
import { filterStatus, showsQueue, TASK_FILTERS, visibleTasks, type TaskFilterKey } from "../lib/task-filters";
import { Empty } from "../components/Empty";
import { TaskRow } from "../components/TaskRow";
import { TaskQueue } from "../components/TaskQueue";

function TaskList({ tasks, error, withQueue, repoName, instruct }: {
  tasks: TaskSummary[] | undefined;
  error: string | null;
  withQueue: boolean;
  repoName: (id: string | null) => string | undefined;
  instruct: () => void;
}) {
  if (!tasks) return error ? null : <p className="muted">Loading…</p>;
  if (tasks.length) {
    return (
      <ul className="rows card" style={{ padding: "0 16px" }}>
        {tasks.map((task) => (
          <TaskRow key={task.id} m={task} repoName={repoName(task.repoId)} />
        ))}
      </ul>
    );
  }
  if (withQueue) return null;
  return (
    <Empty
      title="No tasks here"
      action={
        <button className="btn btn-primary" onClick={() => instruct()}>
          Start a task
        </button>
      }
    >
      Try another filter.
    </Empty>
  );
}

export function Tasks() {
  const { overview, instruct } = useApp();
  const [filter, setFilter] = useState<TaskFilterKey>("open");
  const status = filterStatus(filter);
  const { data, error } = usePoll(() => filter === "queue" ? Promise.resolve([]) : api.tasks(status), 2500, [status]);
  const withQueue = showsQueue(filter);
  useTick();
  const repoName = repoNamer(overview?.repos);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Tasks</h1>
        <div className="segmented" role="group" aria-label="Filter">
          {TASK_FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        {error && <p role="alert">{error}</p>}
        <TaskList tasks={visibleTasks(filter, data)} error={error} withQueue={withQueue} repoName={repoName} instruct={instruct} />
        {withQueue && <TaskQueue repoName={repoName} instruct={instruct} />}
      </div>
    </>
  );
}
