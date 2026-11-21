import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "@crane/storage";
import { createApp } from "@crane/http-server";
import type { NewTask, Overview, Task } from "@crane/contracts";
import { setupRetention } from "./support/retention-fixture.js";

const ids = (tasks: Task[]) => tasks.map(t => t.id);
const make = (store: Store, title: string, extra: Partial<NewTask> = {}) => store.createTask({
  kind: "maintenance", title, brief: "", repoId: null, autonomy: "observe", ...extra,
});

test("api: tabs share one overview for a moment, and actions show immediately", async (t) => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const task = (title: string) => make(store, title, { repoId: repo.id, autonomy: "propose" });
    const app = createApp(store);
    const computed = t.mock.method(store, "overview");
    const read = async () => {
      const response = await app.request("/api/overview");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      return await response.json() as Overview;
    };

    const first = await read();
    assert.deepEqual(await read(), first);
    assert.equal(computed.mock.callCount(), 1, "a second tab gets the same answer");

    const paused = await app.request("/api/factory/pause", { method: "POST" });
    assert.equal(paused.status, 200);
    assert.equal((await read()).factory.paused, true, "an action shows on the very next poll");
    assert.equal(computed.mock.callCount(), 2);

    const failed = await app.request("/api/tasks/t-unknown/merge", { method: "POST" });
    assert.equal(failed.status, 400);
    await read();
    assert.equal(computed.mock.callCount(), 3, "a failed action may have changed something before it failed");

    // Work the factory does itself shows within the sharing window.
    const queued = task("Started by the factory");
    assert.ok(!(await read()).inFlight.some((x) => x.id === queued.id), "still shared");
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.ok((await read()).inFlight.some((x) => x.id === queued.id));
    assert.equal(computed.mock.callCount(), 4);
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

test("retention API: show, enable and disable; malformed policies save nothing", async t => {
  const { store } = setupRetention(t);
  const app = createApp(store);
  assert.deepEqual(await (await app.request("/api/factory/retention")).json(), { finishedTaskDays: null });
  const post = (body: string) => app.request("/api/factory/retention", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal((await post('{"finishedTaskDays":30}')).status, 200);
  for (const body of ["{", "null", "[]", "{}", ...[0, -1, 1.5, 36501, "30", false, {}].map(finishedTaskDays => JSON.stringify({ finishedTaskDays }))]) {
    assert.equal((await post(body)).status, 400, body);
    assert.deepEqual(store.retentionSettings(), { finishedTaskDays: 30 }, body);
  }
  assert.equal((await post('{"finishedTaskDays":null}')).status, 200);
  assert.deepEqual(store.retentionSettings(), { finishedTaskDays: null });
});
