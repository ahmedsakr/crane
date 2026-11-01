import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, isScheduled, KIND_LABEL, STATUS_LABEL, type BlockedTool, type Task, type TaskStatus } from "../lib/api";
import { ago, plural } from "../lib/format";

export function Dot({ status }: { status: TaskStatus | "on" | "paused" | "off" }) {
  return <span className={`dot dot-${status}`} aria-hidden />;
}

export function StatusChip({ status }: { status: TaskStatus }) {
  const cls =
    status === "needs_review"
      ? "chip chip-crane"
      : status === "done" || status === "approved" || status === "merged"
        ? "chip chip-ok"
        : status === "failed"
          ? "chip chip-bad"
          : "chip";
  return (
    <span className={cls}>
      <Dot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function TaskRow({ m, repoName }: { m: Task; repoName?: string }) {
  const when = m.finishedAt ?? m.startedAt ?? m.createdAt;
  const scheduled = isScheduled(m);
  const state = scheduled
    ? `Scheduled for ${new Date(m.scheduledAt!).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
    : m.status === "running" ? "Working now" : m.status === "merging" ? "Merging now" : STATUS_LABEL[m.status];
  const meta = scheduled ? [state, repoName, KIND_LABEL[m.kind]] : [repoName, KIND_LABEL[m.kind], state];
  return (
    <li>
      <Link className="row" to={`/tasks/${m.id}`}>
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

export function Chevron() {
  return (
    <svg className="row-chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 16 16">
        <path d="M3 14V3h10M5.5 3v3M10.5 3v6" stroke="#131416" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
      {action && <div>{action}</div>}
    </div>
  );
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
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const decide = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ text: done });
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const often = b.tasks > 1 ? `Blocked in ${plural(b.tasks, "task")}` : b.times > 1 ? `Blocked ${b.times} times` : "Blocked once";
  return (
    <div className="blocked-item">
      <div style={{ minWidth: 0 }}>
        <div className="blocked-title">
          Allow <code className="blocked-cmd">{b.label}</code> for {b.repoName}?
        </div>
        <div className="row-meta">
          {often} · {ago(b.lastAt)}
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
          disabled={busy}
          onClick={() => decide(() => api.keepBlocked(b.repoId, b.rule, taskId), `${b.label} stays blocked. Crane won't ask again.`)}
        >
          Keep blocked
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => decide(() => api.allowTool(b.repoId, b.rule, taskId), `Allowed ${b.label} for ${b.repoName}`)}
        >
          Allow
        </button>
      </div>
    </div>
  );
}

// ── toasts ─────────────────────────────────────────────────
type Toast = { text: string; link?: { to: string; label: string } } | null;
const ToastCtx = createContext<(t: Toast) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const show = useCallback(
    (t: Toast) => {
      if (timer) window.clearTimeout(timer);
      setToast(t);
      setTimer(window.setTimeout(() => setToast(null), 4200));
    },
    [timer],
  );
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.link && (
            <Link to={toast.link.to} onClick={() => setToast(null)}>
              {toast.link.label}
            </Link>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
