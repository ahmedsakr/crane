import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edgeScrollSpeed,
  isReorderKey,
  keyboardDrop,
  queueItemClass,
  queueListClass,
  reorderedQueue,
} from "../web/src/lib/queue-reorder.ts";

const queue = ["a", "b", "c", "d"].map((id) => ({ id }));
const order = (next: { id: string }[] | null) => next?.map((task) => task.id).join("") ?? null;

test("reorderedQueue: moves a task before its anchor, or to the end", () => {
  assert.equal(order(reorderedQueue(queue, "c", "a")), "cabd");
  assert.equal(order(reorderedQueue(queue, "a", "d")), "bcad");
  assert.equal(order(reorderedQueue(queue, "a", null)), "bcda");
  assert.equal(queue.map((task) => task.id).join(""), "abcd", "the original stays intact for rollback");
});

test("reorderedQueue: a move that changes nothing returns null", () => {
  assert.equal(reorderedQueue(queue, "b", "b"), null, "before itself");
  assert.equal(reorderedQueue(queue, "b", "c"), null, "before its next neighbour");
  assert.equal(reorderedQueue(queue, "d", null), null, "already last");
  assert.equal(reorderedQueue(queue, "gone", "a"), null, "task was picked up");
  assert.equal(reorderedQueue(queue, "a", "gone"), null, "anchor was picked up");
});

test("keyboardDrop: arrows move one place and Home or End jump", () => {
  assert.deepEqual(keyboardDrop("ArrowUp", 2, queue), { id: "c", beforeId: "b" });
  assert.deepEqual(keyboardDrop("ArrowDown", 1, queue), { id: "b", beforeId: "d" });
  assert.deepEqual(keyboardDrop("ArrowDown", 2, queue), { id: "c", beforeId: null }, "one from the end lands last");
  assert.deepEqual(keyboardDrop("Home", 3, queue), { id: "d", beforeId: "a" });
  assert.deepEqual(keyboardDrop("End", 0, queue), { id: "a", beforeId: null });
});

test("keyboardDrop: arrows stop at the ends, and other keys do nothing", () => {
  assert.equal(keyboardDrop("ArrowUp", 0, queue), null);
  assert.equal(keyboardDrop("ArrowDown", 3, queue), null);
  assert.equal(keyboardDrop("a", 1, queue), null);
});

test("isReorderKey: only the four advertised keys", () => {
  for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) assert.ok(isReorderKey(key));
  for (const key of ["Enter", "Escape", " "]) assert.ok(!isReorderKey(key));
});

test("edgeScrollSpeed: still in the middle, faster toward each edge, capped", () => {
  assert.equal(edgeScrollSpeed(400, 800), 0);
  assert.equal(edgeScrollSpeed(72, 800), 0);
  assert.equal(edgeScrollSpeed(728, 800), 0);
  assert.equal(edgeScrollSpeed(64, 800), -2);
  assert.equal(edgeScrollSpeed(736, 800), 2);
  assert.equal(edgeScrollSpeed(0, 800), -16);
  assert.equal(edgeScrollSpeed(800, 800), 16);
});

test("queue classes: mark the held row, its drop point, and a drop at the end", () => {
  const drop = { id: "a", beforeId: "c" };
  assert.equal(queueItemClass("a", drop), "queue-item queue-dragging");
  assert.equal(queueItemClass("c", drop), "queue-item queue-drop-before");
  assert.equal(queueItemClass("b", drop), "queue-item");
  assert.equal(queueItemClass("a", null), "queue-item");
  assert.equal(queueListClass(null), "rows card queue-list");
  assert.equal(queueListClass(drop), "rows card queue-list");
  assert.equal(queueListClass({ id: "a", beforeId: null }), "rows card queue-list queue-drop-end");
});
