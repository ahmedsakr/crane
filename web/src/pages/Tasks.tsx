import { useState } from "react";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import { usePoll, useTick } from "../lib/hooks";
import { Empty, TaskRow } from "../components/bits";
import { TaskQueue } from "../components/TaskQueue";

const FILTERS = [
  { key: "open", label: "Open", status: "needs_review,merging,running,queued" },
  { key: "queue", label: "Queue", status: "queued" },
  { key: "review", label: "Needs you", status: "needs_review" },
  { key: "finished", label: "Finished", status: "merged,done,approved,rejected" },
  { key: "problems", label: "Failed", status: "failed,cancelled" },
  { key: "all", label: "All", status: "" },
] as const;

export function Tasks() {
  const { overview, instruct } = useApp();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const status = FILTERS.find((f) => f.key === filter)!.status;
  const { data, error } = usePoll(() => filter === "queue" ? Promise.resolve([]) : api.tasks(status), 2500, [status]);
  const showsQueue = filter === "open" || filter === "all" || filter === "queue";
  const tasks = filter === "queue" ? [] : data?.filter(m => !showsQueue || m.status !== "queued");
  useTick();
  const repoName = (id: string | null) => overview?.repos.find((r) => r.id === id)?.name;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Tasks</h1>
        <div className="segmented" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        {error && <p role="alert">{error}</p>}
        {!tasks ? (
          !error && <p className="muted">Loading…</p>
        ) : tasks.length ? (
          <ul className="rows card" style={{ padding: "0 16px" }}>
            {tasks.map((m) => (
              <TaskRow key={m.id} m={m} repoName={repoName(m.repoId)} />
            ))}
          </ul>
        ) : !showsQueue ? (
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
        ) : null}
        {showsQueue && <TaskQueue repoName={repoName} instruct={instruct} />}
      </div>
    </>
  );
}
