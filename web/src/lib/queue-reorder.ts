/** The decisions behind reordering the queue. Pure: no DOM and no React. */

/** Where a held row would land. A null `beforeId` means the end of the queue. */
export interface QueueDrop {
  id: string;
  beforeId: string | null;
}

const REORDER_KEYS = ["ArrowUp", "ArrowDown", "Home", "End"];
const EDGE_SIZE = 72;
const MAX_SCROLL_SPEED = 16;

/** The queue after a move, or null when the move changes nothing. */
export function reorderedQueue<T extends { id: string }>(queue: T[], id: string, beforeId: string | null): T[] | null {
  const from = queue.findIndex((task) => task.id === id);
  if (from < 0 || beforeId === id) return null;
  const next = queue.filter((task) => task.id !== id);
  const to = beforeId === null ? next.length : next.findIndex((task) => task.id === beforeId);
  if (to < 0 || from === to) return null;
  next.splice(to, 0, queue[from]!);
  return next;
}

export function isReorderKey(key: string): boolean {
  return REORDER_KEYS.includes(key);
}

/** Where a key sends the row at `index`, or null when it can't go that way. */
export function keyboardDrop(key: string, index: number, queue: { id: string }[]): QueueDrop | null {
  const id = queue[index]!.id;
  if (key === "ArrowUp" && index > 0) return { id, beforeId: queue[index - 1]!.id };
  if (key === "ArrowDown" && index < queue.length - 1) return { id, beforeId: queue[index + 2]?.id ?? null };
  if (key === "Home") return { id, beforeId: queue[0]!.id };
  if (key === "End") return { id, beforeId: null };
  return null;
}

/** Pixels per frame to scroll while a pointer is held near the viewport's top or bottom edge. */
export function edgeScrollSpeed(y: number, viewportHeight: number): number {
  if (y < EDGE_SIZE) return -Math.min(MAX_SCROLL_SPEED, (EDGE_SIZE - y) / 4);
  if (y > viewportHeight - EDGE_SIZE) return Math.min(MAX_SCROLL_SPEED, (y - viewportHeight + EDGE_SIZE) / 4);
  return 0;
}

export function queueListClass(drop: QueueDrop | null): string {
  return `rows card queue-list${drop?.beforeId === null ? " queue-drop-end" : ""}`;
}

export function queueItemClass(id: string, drop: QueueDrop | null): string {
  return `queue-item${drop?.id === id ? " queue-dragging" : ""}${drop?.beforeId === id ? " queue-drop-before" : ""}`;
}
