import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "@crane/http-server";
import { researchResult, setupGoal } from "./support/goal-fixture.js";

test("goals API: malformed decisions, stale versions and invalid graphs do not start work", async () => {
  const { store, goal } = setupGoal();
  try {
    const app = createApp(store);
    const ready = researchResult(store, goal);
    const send = (path: string, body: unknown, method = "POST") => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [null, [], true, {}, { revision: ready.revision, autoMerge: "yes" }, { revision: goal.revision }]) {
      assert.equal((await send(`/api/goals/${goal.id}/approve`, body)).status, 400);
      assert.equal(store.listTasks().length, 1);
    }
    assert.equal((await send(`/api/goals/${goal.id}/plan`, { revision: ready.revision, plan: {} }, "PUT")).status, 400);
    assert.equal((await app.request("/api/goals/missing")).status, 404);
    const response = await send(`/api/goals/${goal.id}/approve`, { revision: ready.revision, autoMerge: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tasks.length, 4);
    const detail = await (await app.request(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.tasks.length, 4);
    const taskDetail = await (await app.request(`/api/tasks/${detail.tasks[0].id}`)).json();
    assert.equal(taskDetail.goalId, goal.id);
  } finally { store.close(); }
});
