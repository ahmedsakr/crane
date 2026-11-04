import type { Task } from "@crane/contracts";

/** The checks Crane ran on the candidate, with their logs a tap away. */
export function ValidationRuns({ task }: { task: Task }) {
  return <>
    {task.report?.validation?.map((run, i) => (
      <details key={i} className="card card-pad">
        <summary>{run.phase} check: {run.status} · {run.command ?? "Configuration"}</summary>
        <p className="mono">{run.commit} · exit {run.exitCode ?? "—"} · {run.durationMs} ms</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{run.logs}</pre>
      </details>
    ))}
  </>;
}
