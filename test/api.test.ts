import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { createApp } from "../src/server/app.js";

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
