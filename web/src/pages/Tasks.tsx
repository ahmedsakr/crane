import { useState } from "react";
import { useApp } from "../lib/app-context";
import { api } from "../lib/api";
import { usePoll, useTick } from "../lib/hooks";
import { Empty, TaskRow } from "../components/bits";

const FILTERS = [
  { key: "open", label: "Open", status: "needs_review,merging,running,queued" },
  { key: "review", label: "Needs you", status: "needs_review" },
  { key: "finished", label: "Finished", status: "merged,done,approved,rejected" },
  { key: "problems", label: "Failed", status: "failed,cancelled" },
  { key: "all", label: "All", status: "" },
] as const;

export function Tasks() {
  const { overview, instruct } = useApp();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const status = FILTERS.find((f) => f.key === filter)!.status;
  const { data } = usePoll(() => api.tasks(status), 2500, [status]);
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
        {!data ? (
          <p className="muted">Loading…</p>
        ) : data.length ? (
          <ul className="rows card" style={{ padding: "0 16px" }}>
            {data.map((m) => (
              <TaskRow key={m.id} m={m} repoName={repoName(m.repoId)} />
            ))}
          </ul>
        ) : (
          <Empty
            title={filter === "open" ? "Nothing open" : "No tasks here"}
            action={
              <button className="btn btn-primary" onClick={() => instruct()}>
                Start a task
              </button>
            }
          >
            {filter === "open" ? "Everything the factory was asked to do is finished." : "Try another filter."}
          </Empty>
        )}
      </div>
    </>
  );
}
