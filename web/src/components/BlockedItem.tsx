import { Link } from "react-router-dom";
import { useAction } from "../lib/action";
import { api, type BlockedTool } from "../lib/api";
import { ago, plural } from "../lib/format";

function blockedHowOften(b: BlockedTool): string {
  if (b.tasks > 1) return `Blocked in ${plural(b.tasks, "task")}`;
  return b.times > 1 ? `Blocked ${b.times} times` : "Blocked once";
}

/**
 * One blocked command, as a decision: allow it for the repo, or keep it
 * blocked and stop asking. `taskId` notes the choice on the task it came from.
 */
export function BlockedItem({
  b,
  taskId,
  showTask,
  onDone,
}: {
  b: BlockedTool;
  taskId?: string;
  /** Link to the task that last hit it (on Home, where there's no task in view). */
  showTask?: boolean;
  onDone: () => void;
}) {
  const { busy, run } = useAction(onDone);
  return (
    <div className="blocked-item">
      <div style={{ minWidth: 0 }}>
        <div className="blocked-title">
          Allow <code className="blocked-cmd">{b.label}</code> for {b.repoName}?
        </div>
        <div className="row-meta">
          {blockedHowOften(b)} · {ago(b.lastAt)}
          {showTask && (
            <>
              {" · "}
              <Link to={`/tasks/${b.lastTaskId}`}>Latest task</Link>
            </>
          )}
        </div>
      </div>
      <div className="actions">
        <button
          className="btn btn-quiet btn-sm"
          disabled={!!busy}
          onClick={() => run("keep", () => api.keepBlocked(b.repoId, b.rule, taskId), `${b.label} stays blocked. Crane won't ask again.`)}
        >
          Keep blocked
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={!!busy}
          onClick={() => run("allow", () => api.allowTool(b.repoId, b.rule, taskId), `Allowed ${b.label} for ${b.repoName}`)}
        >
          Allow
        </button>
      </div>
    </div>
  );
}
