import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ToastContext, type ToastMessage } from "../lib/toast";

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const show = useCallback(
    (t: ToastMessage | null) => {
      if (timer) window.clearTimeout(timer);
      setToast(t);
      setTimer(window.setTimeout(() => setToast(null), 4200));
    },
    [timer],
  );
  return (
    <ToastContext.Provider value={show}>
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
    </ToastContext.Provider>
  );
}
