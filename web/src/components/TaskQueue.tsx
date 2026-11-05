import { useId } from "react";
import type { TaskSummary } from "../lib/api";
import { queueItemClass, queueListClass } from "../lib/queue-reorder";
import { useQueueDrag, useTaskQueue, type QueueDragControls } from "../lib/use-task-queue";
import { TaskRow } from "./TaskRow";

type RepoName = (id: string | null) => string | undefined;

function QueueGrip() {
  return (
    <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
      {[5, 10, 15].map((y) => <g key={y}><circle cx="5" cy={y} r="1.3" /><circle cx="11" cy={y} r="1.3" /></g>)}
    </svg>
  );
}

function QueueHandle({ task, index, queue, saving, helpId, drag }: {
  task: TaskSummary;
  index: number;
  queue: TaskSummary[];
  saving: boolean;
  helpId: string;
  drag: QueueDragControls;
}) {
  return (
    <button className="queue-handle" type="button" aria-label={`Reorder ${task.title}, position ${index + 1} of ${queue.length}`}
      aria-describedby={helpId} aria-disabled={saving || queue.length < 2} aria-keyshortcuts="ArrowUp ArrowDown Home End"
      title="Drag to reorder, or use the up and down arrow keys"
      onPointerDown={(e) => drag.onPointerDown(e, task.id)} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.cancel} onLostPointerCapture={drag.cancel}
      onKeyDown={(e) => drag.onKeyDown(e, index, queue)}>
      <QueueGrip />
      <span className="queue-position" aria-hidden="true">{index + 1}</span>
    </button>
  );
}

function QueueBody({ queue, error, saving, helpId, drag, repoName, instruct }: {
  queue: TaskSummary[] | null;
  error: string | null;
  saving: boolean;
  helpId: string;
  drag: QueueDragControls;
  repoName: RepoName;
  instruct: () => void;
}) {
  if (!queue) return error ? null : <p className="muted">Loading queue…</p>;
  if (!queue.length) {
    return <div className="empty"><strong>No tasks queued</strong><button className="btn btn-primary" onClick={() => instruct()}>Start a task</button></div>;
  }
  return (
    <ul ref={drag.list} className={queueListClass(drag.drop)}>
      {queue.map((task, index) => (
        <TaskRow key={task.id} m={task} repoName={repoName(task.repoId)} reorder={{
          props: { className: queueItemClass(task.id, drag.drop) },
          handle: <QueueHandle task={task} index={index} queue={queue} saving={saving} helpId={helpId} drag={drag} />,
        }} />
      ))}
    </ul>
  );
}

/** A separate queue keeps the full pickup order visible even beyond the task-list limit. */
export function TaskQueue({ repoName, instruct }: { repoName: RepoName; instruct: () => void }) {
  const state = useTaskQueue();
  const drag = useQueueDrag(state);
  const { queue, error, moveError, saving, message, refresh } = state;
  const helpId = useId();

  return (
    <section className="task-queue" aria-label="Queue" aria-busy={saving}>
      <h2 className="section-title">Queue{queue ? ` · ${queue.length}` : ""}</h2>
      <p className="muted queue-help" id={helpId}>
        Drag a handle to change pickup order, or focus it and use ↑ / ↓. Start times, prerequisites and crew assignments still apply.
      </p>
      {error && <p className="queue-error" role="alert">{error} <button className="btn btn-quiet btn-sm" onClick={() => void refresh()}>Refresh queue</button></p>}
      {moveError && <p className="queue-error" role="alert">{moveError}</p>}
      <p className="sr-only" role="status">{message}</p>
      <QueueBody queue={queue} error={error} saving={saving} helpId={helpId} drag={drag} repoName={repoName} instruct={instruct} />
    </section>
  );
}
