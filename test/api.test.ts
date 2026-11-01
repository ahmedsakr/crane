import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { createApp } from "../src/server/app.js";
import { ALL_STATUSES } from "@crane/contracts";
import { driverEffortKey, driverModelKey } from "../src/factory/drivers.js";

test("api: invalid task decision bodies leave tasks and history unchanged", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const action of ["approve", "reject", "retry"]) {
      const task = store.createTask({ kind: "maintenance", title: action, brief: "", repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}` });
      const before = store.getTask(task.id);
      const events = store.listEvents(task.id);
      const tasks = store.listTasks();
      const bodies = ["{", '{"merge":false', "null", "[]", "true", "42", '"text"'];
      if (action === "approve") {
        bodies.push(...["false", 0, 1, null, [], {}].map(merge => JSON.stringify({ merge })));
      }
      if (action !== "retry") {
        bodies.push(...[42, false, null, [], {}].map(note => JSON.stringify({ note })));
      }
      for (const body of bodies) {
        const response = await app.request(`/api/tasks/${task.id}/${action}`, {
          method: "POST", headers: { "content-type": "application/json" }, body,
        });
        const context = `${action}: ${body}`;
        assert.equal(response.status, 400, context);
        assert.deepEqual(store.getTask(task.id), before, context);
        assert.deepEqual(store.listEvents(task.id), events, context);
        assert.deepEqual(store.listTasks(), tasks, context);
      }
    }
  } finally { store.close(); }
});

test("api: approval keeps empty-body defaults and honors approve only", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const body of [undefined, "{}", '{"merge":true}', '{"merge":false,"note":"Reviewed"}']) {
      const task = store.createTask({ kind: "maintenance", title: "Approve", brief: "", repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status: "needs_review", branch: `crane/${task.id}` });
      const response = await app.request(`/api/tasks/${task.id}/approve`, { method: "POST", body });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, body?.includes("false") ? "approved" : "merging");
      if (body?.includes("Reviewed")) {
        assert.ok(store.listEvents(task.id).some(e => e.type === "operator" && e.message === "Approved: Reviewed"));
      }
    }
    for (const action of ["reject", "retry"]) {
      const task = store.createTask({ kind: "maintenance", title: action, brief: "", repoId: repo.id, autonomy: "observe" });
      store.updateTask(task.id, { status: "needs_review" });
      const response = await app.request(`/api/tasks/${task.id}/${action}`, { method: "POST" });
      assert.equal(response.status, action === "retry" ? 201 : 200);
      assert.equal((await response.json()).status, action === "retry" ? "queued" : "rejected");
    }
  } finally { store.close(); }
});

test("api: invalid effort cannot partially save or clear the model", async () => {
  const store = new Store(":memory:");
  try {
    store.setSetting(driverModelKey("codex"), "gpt-saved");
    store.setSetting(driverEffortKey("codex"), "high");
    const app = createApp(store);
    for (const model of ["gpt-replacement", null, "default"]) {
      for (const effort of ["invalid", 42]) {
        const response = await app.request("/api/drivers/codex", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, effort }),
        });
        assert.equal(response.status, 400);
        assert.equal(store.getSetting(driverModelKey("codex")), "gpt-saved");
        assert.equal(store.getSetting(driverEffortKey("codex")), "high");
      }
    }
  } finally { store.close(); }
});

test("api: invalid check settings cannot replace the operator's merge gates", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/factory", isFactory: true });
    const other = store.addRepo({ path: "/other" });
    const app = createApp(store);
    const put = (id: string, body: unknown) => app.request(`/api/repos/${id}/checks`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    for (const body of [null, {}, "npm test", [""], ["  "], ["npm test", 42]]) {
      const response = await put(repo.id, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: "Expected an array of nonempty commands" });
      assert.deepEqual(store.repoChecks(repo.id), ["npm run typecheck", "npm test"]);
    }
    assert.equal((await put("r-missing", ["npm test"])).status, 404);
    for (const commands of [["npm run lint", "npm test"], []]) {
      const response = await put(repo.id, commands);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), commands);
      assert.deepEqual(await (await app.request(`/api/repos/${repo.id}/checks`)).json(), commands);
      assert.deepEqual(store.repoChecks(other.id), [], "settings stay scoped to the selected repo");
    }
  } finally { store.close(); }
});

test("api: premature approval is rejected without changing the task or its history", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const task = store.createTask({ kind: "maintenance", title: "Fix", brief: "", repoId: repo.id, autonomy: "propose" });
    const app = createApp(store);
    const events = store.listEvents(task.id);
    const response = await app.request(`/api/tasks/${task.id}/approve`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /isn't waiting for review/);
    assert.deepEqual(store.getTask(task.id), task);
    assert.deepEqual(store.listEvents(task.id), events);
    assert.equal((await app.request("/api/tasks/t-missing")).status, 404);
  } finally { store.close(); }
});

test("api: task actions reject invalid states without changing tasks or history", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const action of ["approve", "reject", "cancel", "merge"]) {
      const allowed = action === "cancel" ? ["queued", "running"]
        : action === "merge" ? ["needs_review", "approved", "done"] : ["needs_review"];
      for (const status of ALL_STATUSES.filter(status => !allowed.includes(status))) {
        const task = store.createTask({ kind: "maintenance", title: `${action} ${status}`, brief: "", repoId: repo.id, autonomy: "propose" });
        // A branch makes merge exercise its state guard rather than its no-code guard.
        store.updateTask(task.id, { status, branch: `crane/${task.id}` });
        const before = store.getTask(task.id);
        const events = store.listEvents(task.id);
        const response = await app.request(`/api/tasks/${task.id}/${action}`, { method: "POST" });
        const context = `${action} from ${status}`;
        assert.equal(response.status, 400, context);
        assert.match((await response.json()).error, /isn't (waiting for review|in progress|ready to merge)/, context);
        assert.deepEqual(store.getTask(task.id), before, context);
        assert.deepEqual(store.listEvents(task.id), events, context);
      }
    }
  } finally { store.close(); }
});

test("api: cancellation records the decision once and cannot cancel a finished task", async () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: "/repo" });
    const app = createApp(store);
    for (const status of ["queued", "running"] as const) {
      const task = store.createTask({ kind: "maintenance", title: status, brief: "", repoId: repo.id, autonomy: "observe" });
      store.updateTask(task.id, { status });
      const response = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "cancelled");
      const cancelled = store.getTask(task.id)!;
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.finishedAt);
      const events = store.listEvents(task.id);
      assert.equal(events.filter(e => e.type === "operator" && e.message === "Cancelled by operator").length, 1);
      assert.equal((await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" })).status, 400);
      assert.deepEqual(store.getTask(task.id), cancelled);
      assert.deepEqual(store.listEvents(task.id), events);
    }
  } finally { store.close(); }
});
