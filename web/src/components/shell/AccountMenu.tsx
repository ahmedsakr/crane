import { useEffect, useRef, useState, type RefObject } from "react";
import { errorMessage, type OperatorProfile } from "@crane/contracts";
import { ROLE_LABEL, initialOf, isSignedOut } from "../../lib/auth";
import { useToast } from "../../lib/toast";
import { useAuth } from "../../lib/use-auth";

/** One line in the account menu. Account settings and operator management add theirs here. */
export interface AccountMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
}

/** Close on Escape (returning focus to the button) or on a press anywhere outside the menu. */
function useDismiss(open: boolean, close: (refocus: boolean) => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, root]);
}

export function AccountMenuList({ operator, items, onPick }: { operator: OperatorProfile; items: AccountMenuItem[]; onPick: (item: AccountMenuItem) => void }) {
  return (
    <div className="account-menu" role="menu" aria-label="Account">
      <div className="account-menu-who">
        <strong>{operator.name || operator.username}</strong>
        <small>
          {ROLE_LABEL[operator.role]} · <span className="mono">{operator.username}</span>
        </small>
      </div>
      {items.map((item) => (
        <button key={item.key} type="button" role="menuitem" onClick={() => onPick(item)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Who is signed in, one tap from anywhere: their initial, with their name beside it where there's room. */
export function AccountMenu() {
  const { status, operator, signOut } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [close] = useState(() => (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  });
  useDismiss(open, close, root);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);
  // A factory without sign-in has no account to show.
  if (!status?.required || !operator) return null;
  const name = operator.name || operator.username;
  const failed = (e: unknown) => !isSignedOut(e) && toast({ text: `Couldn't sign out: ${errorMessage(e)}` });
  const items: AccountMenuItem[] = [{ key: "sign-out", label: "Sign out", onSelect: () => void signOut().catch(failed) }];
  return (
    <div className="account" ref={root}>
      <button ref={button} type="button" className="account-button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Account: ${name}`} onClick={() => setOpen((o) => !o)}>
        <span className="account-initial" aria-hidden>{initialOf(operator.name, operator.username)}</span>
        <span className="account-name">{name}</span>
      </button>
      {open && <AccountMenuList operator={operator} items={items} onPick={(item) => { close(false); item.onSelect(); }} />}
    </div>
  );
}
