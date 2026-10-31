// Where a popover menu goes on screen. Pure so it can be tested without a DOM.

export interface MenuPlace {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxHeight: number;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

const GAP = 6;
const MARGIN = 12;
const MAX_HEIGHT = 340;
const MIN_HEIGHT = 120;

/**
 * Place a menu against its button, in viewport pixels (for `position: fixed`).
 * Opens below unless it doesn't fit there and there's more room above, caps its
 * height to the room it has, and slides left only as far as needed to stay on screen.
 */
export function placeMenu(
  btn: Box,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): MenuPlace {
  const room = viewport.width - MARGIN * 2;
  const minWidth = Math.min(btn.width, room);
  const width = Math.min(Math.max(menu.width, minWidth), room);
  const left = Math.max(MARGIN, Math.min(btn.left, viewport.width - MARGIN - width));

  const below = viewport.height - btn.bottom - GAP - MARGIN;
  const above = btn.top - GAP - MARGIN;
  const wanted = Math.min(menu.height, MAX_HEIGHT);
  const flip = below < wanted && above > below;
  return {
    ...(flip ? { bottom: viewport.height - btn.top + GAP } : { top: btn.bottom + GAP }),
    left,
    minWidth,
    maxHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, flip ? above : below)),
  };
}
