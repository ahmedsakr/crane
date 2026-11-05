import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary';

const SheetContext = createContext<{ titleId: string; onClose: () => void }>({ titleId: "", onClose: () => {} });

/** Hides the page's scrollbar without moving the page. Returns how to put it back. */
function lockPageScroll(): () => void {
  const { body, documentElement } = document;
  const { overflow, paddingRight } = body.style;
  const scrollbar = window.innerWidth - documentElement.clientWidth;
  body.style.overflow = "hidden";
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
  return () => {
    body.style.overflow = overflow;
    body.style.paddingRight = paddingRight;
  };
}

/** Keeps Tab inside the panel by wrapping focus at its first and last items. */
function trapTab(e: KeyboardEvent, panel: HTMLElement | null) {
  if (e.key !== "Tab" || !panel) return;
  const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first?.focus();
  }
}

/**
 * A modal panel: pinned head and foot around a body that scrolls, a bottom sheet
 * on phones. Holds focus while open and hands it back to what opened it.
 *
 * `onDismiss` is what Escape and tapping outside do, so a form opened from another
 * view can step back to it. `onClose` is the close button, which always leaves.
 * Change `view` when the contents swap, so focus and reading start at the top.
 */
export function Sheet({ onClose, onDismiss = onClose, view, children }: {
  onClose: () => void;
  onDismiss?: () => void;
  view?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const unlockPageScroll = lockPageScroll();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The instruct sheet can open over this one and owns Escape while it has focus.
      const active = document.activeElement;
      if (active && active !== document.body && !panel.current?.contains(active)) return;
      dismiss.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlockPageScroll();
      opener?.focus();
    };
  }, []);

  useEffect(() => panel.current?.focus(), [view]);

  return (
    <div className="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && onDismiss()}>
      <div className="sheet sheet-pane" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel} onKeyDown={(e) => trapTab(e, panel.current)}>
        <SheetContext.Provider value={{ titleId, onClose }}>{children}</SheetContext.Provider>
      </div>
    </div>
  );
}

export function SheetHead({ title, subtitle, leading, onBack }: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  onBack?: () => void;
}) {
  const { titleId, onClose } = useContext(SheetContext);
  return (
    <header className="sheet-pane-head">
      {onBack && (
        <button type="button" className="sheet-icon" onClick={onBack} aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {leading}
      <div className="sheet-pane-titles">
        <h2 className="sheet-pane-title" id={titleId}>{title}</h2>
        {subtitle && <p className="sheet-pane-subtitle">{subtitle}</p>}
      </div>
      <button type="button" className="sheet-icon" onClick={onClose} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}

export function SheetBody({ children }: { children: ReactNode }) {
  return <div className="sheet-pane-body">{children}</div>;
}

/** Pinned actions. `note` sits to their left: a stat, a warning, or an error. */
export function SheetFoot({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <footer className="sheet-pane-foot">
      {note && <div className="sheet-pane-note">{note}</div>}
      <div className="sheet-pane-actions">{children}</div>
    </footer>
  );
}
