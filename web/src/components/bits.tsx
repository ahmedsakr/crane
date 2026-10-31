import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { KIND_LABEL, STATUS_LABEL, type Mission, type MissionStatus } from "../lib/api";
import { ago } from "../lib/format";

export function Dot({ status }: { status: MissionStatus | "on" | "paused" | "off" }) {
  return <span className={`dot dot-${status}`} aria-hidden />;
}

export function StatusChip({ status }: { status: MissionStatus }) {
  const cls =
    status === "needs_review"
      ? "chip chip-crane"
      : status === "done" || status === "approved"
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

export function MissionRow({ m, repoName }: { m: Mission; repoName?: string }) {
  const when = m.finishedAt ?? m.startedAt ?? m.createdAt;
  return (
    <li>
      <Link className="row" to={`/missions/${m.id}`}>
        <Dot status={m.status} />
        <span style={{ minWidth: 0 }}>
          <span className="row-title" style={{ display: "block" }}>
            {m.title}
          </span>
          <span className="row-meta" style={{ display: "block" }}>
            {[repoName, KIND_LABEL[m.kind], m.status === "running" ? "Working now" : STATUS_LABEL[m.status]]
              .filter(Boolean)
              .join(" · ")}
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
