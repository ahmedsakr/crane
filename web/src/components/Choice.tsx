import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type MenuPlace } from "../lib/placement";

type ButtonRef = RefObject<HTMLButtonElement | null>;
type MenuRef = RefObject<HTMLUListElement | null>;

export interface ChoiceOption<T> {
  value: T;
  label: string;
  hint?: string;
}

function useMenuDismiss(open: boolean, setOpen: (open: boolean) => void, btnRef: ButtonRef, menuRef: MenuRef) {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    // Escape closes the menu first; the sheet only closes on a second press.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen, btnRef, menuRef]);
}

/**
 * The menu lives in a portal with fixed positioning so the sheet and the
 * scrolling scrim can never clip it. Place it against the button, flip it
 * above when there is more room there, and keep it inside the viewport.
 */
function useMenuPlace(open: boolean, optionCount: number, btnRef: ButtonRef, menuRef: MenuRef) {
  const [place, setPlace] = useState<MenuPlace | null>(null);
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const update = () => {
      const btn = btnRef.current;
      const menu = menuRef.current;
      if (!btn || !menu) return;
      setPlace(
        placeMenu(
          btn.getBoundingClientRect(),
          { width: menu.offsetWidth, height: menu.scrollHeight },
          { width: document.documentElement.clientWidth, height: window.innerHeight },
        ),
      );
    };
    // Follow the button when the scrim (or anything else) scrolls, but not when
    // the operator scrolls the menu's own list.
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && update();
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, optionCount, btnRef, menuRef]);
  return place;
}

function ChoiceMenu<T extends string | null>({ menuRef, place, value, options, onPick }: {
  menuRef: MenuRef;
  place: MenuPlace | null;
  value: T;
  options: ChoiceOption<T>[];
  onPick: (v: T) => void;
}) {
  return (
    <ul
      className="menu"
      role="menu"
      ref={menuRef}
      style={
        place
          ? { top: place.top, bottom: place.bottom, left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight }
          : { visibility: "hidden" }
      }
    >
      {options.map((o) => (
        <li key={String(o.value)}>
          <button type="button" role="menuitemradio" aria-checked={o.value === value} onClick={() => onPick(o.value)}>
            <strong style={{ fontWeight: 600, fontSize: 14 }}>{o.label}</strong>
            {o.hint && <small>{o.hint}</small>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A labelled button that opens a menu of options, showing the current one and why it was picked. */
export function Choice<T extends string | null>(props: {
  k: string;
  value: T;
  label: string;
  why: string;
  options: ChoiceOption<T>[];
  onChange: (v: T) => void;
  unset?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  useMenuDismiss(open, setOpen, btnRef, menuRef);
  const place = useMenuPlace(open, props.options.length, btnRef, menuRef);
  const pick = (v: T) => {
    props.onChange(v);
    setOpen(false);
  };

  return (
    <div className="choice">
      <button
        ref={btnRef}
        type="button"
        className={`choice-btn ${props.unset ? "unset" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="choice-k">{props.k}</span>
        <span className="choice-v">{props.label}</span>
        <span className="choice-why">{props.why}</span>
      </button>
      {open &&
        createPortal(
          <ChoiceMenu menuRef={menuRef} place={place} value={props.value} options={props.options} onPick={pick} />,
          document.body,
        )}
    </div>
  );
}
