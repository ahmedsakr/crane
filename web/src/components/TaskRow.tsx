import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { isScheduled, KIND_LABEL, STATUS_LABEL, type TaskSummary } from "../lib/api";
import { ago } from "../lib/format";
import { Chevron } from "./Chevron";
import { Dot } from "./Status";

function rowState(m: TaskSummary): string {
  if (isScheduled(m)) return `Scheduled for ${new Date(m.scheduledAt!).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  if (m.status === "running") return "Working now";
  if (m.status === "merging") return "Merging now";
  return STATUS_LABEL[m.status];
}

export function TaskRow({ m, repoName, reorder }: {
  m: TaskSummary;
  repoName?: string;
  reorder?: { handle: ReactNode; props: HTMLAttributes<HTMLLIElement> };
}) {
  const when = m.finishedAt ?? m.startedAt ?? m.createdAt;
  const scheduled = isScheduled(m);
  const state = rowState(m);
  const meta = scheduled ? [state, repoName, KIND_LABEL[m.kind]] : [repoName, KIND_LABEL[m.kind], state];
  return (
    <li {...reorder?.props} data-queue-id={reorder ? m.id : undefined}>
      {reorder?.handle}
      <Link className="row" to={`/tasks/${m.id}`} draggable={reorder ? false : undefined}>
        <Dot status={m.status} />
        <span style={{ minWidth: 0 }}>
          <span className="row-title" style={{ display: "block" }}>
            {m.title}
          </span>
          <span className="row-meta" style={{ display: "block", ...(scheduled ? { whiteSpace: "normal" } : {}) }}>
            {meta.filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="row-right">{ago(when)}</span>
        <Chevron />
      </Link>
    </li>
  );
}
