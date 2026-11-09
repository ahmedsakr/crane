import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "@crane/storage";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import type { NewTask, Task } from "@crane/contracts";

const ids = (tasks: Task[]) => tasks.map(t => t.id);
const make = (store: Store, title: string, extra: Partial<NewTask> = {}) => store.createTask({
  kind: "maintenance", title, brief: "", repoId: null, autonomy: "observe", ...extra,
});

test("queue: moves persist across connections and restarts, and new work joins the end", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-queue-"));
  const file = join(dir, "queue.db");
  let store = new Store(file);
  try {
    const a = make(store, "First");
    const b = make(store, "Second");
    const c = make(store, "Third");
    const before = store.getTask(c.id);
    const actions = new OperatorActions(store);
    assert.deepEqual(ids(actions.moveQueuedTask(c.id, a.id)), [c.id, a.id, b.id]);
    assert.deepEqual(store.getTask(c.id), before, "reordering doesn't rewrite timestamps or task gates");
    assert.equal(store.listEvents(c.id).at(-1)?.type, "operator");
    const other = new Store(file);
    try {
      assert.deepEqual(ids(other.listQueuedTasks()), [c.id, a.id, b.id]);
      const d = make(other, "Appended by another process");
      assert.deepEqual(ids(actions.moveQueuedTask(b.id, null)), [c.id, a.id, d.id, b.id]);
      assert.deepEqual(ids(other.listQueuedTasks()), [c.id, a.id, d.id, b.id]);
      store.close();
      store = new Store(file);
      assert.deepEqual(ids(store.listQueuedTasks()), [c.id, a.id, d.id, b.id]);
      assert.equal(store.claimNextTask("a-one")?.id, c.id);
      assert.equal(other.claimNextTask("a-two")?.id, a.id);
      assert.equal(store.claimNextTask("a-three")?.id, d.id);
      assert.equal(other.claimNextTask("a-four")?.id, b.id);
      assert.equal(store.claimNextTask("a-five"), null);
    } finally { other.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("queue: migration keeps FIFO, including creation-time ties, and appends new tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-old-queue-"));
  const file = join(dir, "queue.db");
  const initial = new Store(file);
  const a = make(initial, "Inserted first, created later");
  const b = make(initial, "Oldest");
  const c = make(initial, "Tied with oldest");
  initial.db.prepare("UPDATE tasks SET created_at = ?").run("2020-01-01T00:00:00.000Z");
  initial.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2021-01-01T00:00:00.000Z", a.id);
  initial.close();
  const legacy = new Database(file);
  legacy.exec("ALTER TABLE tasks DROP COLUMN queue_position");
  legacy.close();
  const store = new Store(file);
  try {
    const d = make(store, "New");
    assert.deepEqual(ids(store.listQueuedTasks()), [b.id, c.id, a.id, d.id]);
    assert.equal(store.claimNextTask("a-one")?.id, b.id);
    assert.deepEqual(ids(store.moveQueuedTask(d.id, c.id)), [d.id, c.id, a.id]);
    assert.equal(store.claimNextTask("a-two")?.id, d.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("queue: priority still respects start times, prerequisites and crew assignment", () => {
  const store = new Store(":memory:");
  try {
    const prerequisite = make(store, "Prerequisite");
    store.setStatus(prerequisite.id, "needs_review");
    const ready = make(store, "Ready");
    const future = make(store, "Future", { scheduledAt: "2099-01-01T00:00:00.000Z" });
    const held = make(store, "Held", { prerequisites: [prerequisite.id] });
    const assigned = make(store, "Assigned", { assignee: "a-owner" });
    store.moveQueuedTask(future.id, ready.id);
    store.moveQueuedTask(held.id, future.id);
    store.moveQueuedTask(assigned.id, held.id);
    assert.deepEqual(ids(store.listQueuedTasks()), [assigned.id, held.id, future.id, ready.id]);
    assert.equal(store.claimNextTask("a-other")?.id, ready.id);
    assert.equal(store.claimNextTask("a-other"), null);
    assert.equal(store.claimNextTask("a-owner", { onlyAssigned: true })?.id, assigned.id);
    store.setStatus(prerequisite.id, "done");
    assert.equal(store.claimNextTask("a-other")?.id, held.id);
    assert.equal(store.getTask(future.id)?.scheduledAt, future.scheduledAt);
    assert.equal(store.claimNextTask("a-other"), null);
  } finally { store.close(); }
});

test("queue: stale moves and invalid anchors change neither order nor history; no-ops add no noise", () => {
  const store = new Store(":memory:");
  try {
    const a = make(store, "First");
    const b = make(store, "Second");
    const running = make(store, "Running");
    store.setStatus(running.id, "running");
    const actions = new OperatorActions(store);
    const before = store.listQueuedTasks();
    const events = store.eventsSince(0);
    for (const anchor of [undefined, 42, true, {}, [], "", " "]) {
      assert.throws(() => actions.moveQueuedTask(b.id, anchor), /beforeId/);
    }
    for (const [id, anchor] of [[b.id, running.id], [b.id, "missing"], [running.id, a.id], ["missing", a.id]] as const) {
      assert.throws(() => actions.moveQueuedTask(id, anchor), /isn't queued|No task/);
    }
    actions.moveQueuedTask(a.id, a.id);
    actions.moveQueuedTask(a.id, b.id);
    actions.moveQueuedTask(b.id, null);
    assert.deepEqual(store.listQueuedTasks(), before);
    assert.deepEqual(store.eventsSince(0), events);
  } finally { store.close(); }
});

test("queue: a failed history write rolls back the whole move", (t) => {
  const store = new Store(":memory:");
  try {
    const a = make(store, "First");
    const b = make(store, "Second");
    const before = store.eventsSince(0);
    t.mock.method(store, "addEvent", () => { throw new Error("disk is full"); });
    assert.throws(() => store.moveQueuedTask(b.id, a.id), /disk is full/);
    assert.deepEqual(ids(store.listQueuedTasks()), [a.id, b.id]);
    assert.deepEqual(store.eventsSince(0), before);
  } finally { store.close(); }
});

test("queue API: full pickup order and validated moves, including tasks beyond the list limit", async () => {
  const store = new Store(":memory:");
  try {
    const tasks = Array.from({ length: 205 }, (_, i) => make(store, `Task ${i}`));
    const first = tasks[0]!;
    const tail = tasks[204]!;
    store.updateTask(tail.id, { report: { summary: "Queue summary", findings: [], changedFiles: ["file.ts"] } });
    store.db.prepare("UPDATE tasks SET brief = ? WHERE id = ?").run("Large brief".repeat(10000), tail.id);
    const app = createApp(store);
    const response = await app.request("/api/tasks/queue");
    assert.equal(response.status, 200);
    const queue = await response.json();
    assert.deepEqual(ids(queue), ids(tasks));
    assert.equal(queue[204].reportSummary, "Queue summary");
    assert.equal(queue[204].changedFileCount, 1);
    assert.ok(queue.every((task: object) => !("brief" in task) && !("report" in task)));
    const moved = await app.request(`/api/tasks/${tail.id}/move`, {
      method: "POST", body: JSON.stringify({ beforeId: first.id }),
    });
    assert.equal(moved.status, 200);
    const reordered = await moved.json();
    assert.deepEqual(ids(reordered), [tail.id, ...ids(tasks.slice(0, 204))]);
    assert.deepEqual(reordered[0], queue[204]);
    const last = await app.request(`/api/tasks/${tail.id}/move`, {
      method: "POST", body: JSON.stringify({ beforeId: null }),
    });
    assert.equal(last.status, 200);
    assert.deepEqual(ids(await last.json()), ids(tasks));
    const snapshot = { queue: store.listQueuedTasks(), events: store.eventsSince(0) };
    for (const body of [undefined, "{", "null", "[]", "42", "true", "{}", '{"beforeId":42}', '{"beforeId":""}', '{"beforeId":"missing"}']) {
      const invalid = await app.request(`/api/tasks/${tail.id}/move`, { method: "POST", body });
      assert.equal(invalid.status, 400, body);
      assert.deepEqual({ queue: store.listQueuedTasks(), events: store.eventsSince(0) }, snapshot);
    }
    const forged = await app.request(`/api/tasks/${tail.id}/move`, {
      method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ beforeId: first.id }),
    });
    assert.equal(forged.status, 403);
    assert.deepEqual({ queue: store.listQueuedTasks(), events: store.eventsSince(0) }, snapshot);
    store.claimNextTask("a-one");
    const stale = await app.request(`/api/tasks/${tail.id}/move`, {
      method: "POST", body: JSON.stringify({ beforeId: first.id }),
    });
    assert.equal(stale.status, 400);
  } finally { store.close(); }
});
