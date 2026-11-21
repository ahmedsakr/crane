import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "@crane/storage";
import { createApp } from "@crane/http-server";
import { monday, setupCrewSchedule } from "./support/crew-schedule-fixture.js";

const NOW = new Date("2030-06-15T12:00:00.000Z");
const DUE = "2030-06-15T13:00:00.000Z";

test("scheduling: API creates, lists, reschedules and clears times; rejects malformed input without writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/repo" });
  const app = createApp(store);
  const post = (path: string, body: unknown) => app.request(`/api${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const input = { kind: "maintenance", title: "Scheduled", brief: "Do it", repoId: repo.id, autonomy: "observe" };
    for (const scheduledAt of ["not-a-date", 42, "2030-06-15T13:00", NOW.toISOString()]) {
      assert.equal((await post("/tasks", { ...input, scheduledAt })).status, 400);
    }
    assert.equal(store.listTasks().length, 0);
    const created = await post("/tasks", { ...input, scheduledAt: "2030-06-15T09:00-04:00" });
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal(task.scheduledAt, DUE);
    assert.equal((await (await app.request(`/api/tasks/${task.id}`)).json()).task.scheduledAt, DUE);
    assert.equal((await (await app.request("/api/tasks")).json())[0].scheduledAt, DUE);
    const events = store.listEvents(task.id);
    for (const body of [null, [], {}, "text", { scheduledAt: 42 }, { scheduledAt: "" }]) {
      assert.equal((await post(`/tasks/${task.id}/schedule`, body)).status, 400);
      assert.equal(store.getTask(task.id)!.scheduledAt, DUE);
      assert.deepEqual(store.listEvents(task.id), events);
    }
    const later = "2030-06-15T14:00:00.000Z";
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: later })).status, 200);
    assert.equal(store.getTask(task.id)!.scheduledAt, later);
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: null })).status, 200);
    assert.equal(store.claimNextTask("a-jib")?.id, task.id);
    assert.equal((await post(`/tasks/${task.id}/schedule`, { scheduledAt: DUE })).status, 400);
  } finally { store.close(); }
});

test("crew schedules: API CRUD validates input and ownership without sockets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: monday - 60_000 });
  const { store, input } = setupCrewSchedule();
  const app = createApp(store);
  const base = "/api/agents/a-tests/schedules";
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const bad of [null, {}, [], { ...input, preApprove: "yes" }, { ...input, daysMask: 0 }]) assert.equal((await post(base, bad)).status, 400);
    const created = await post(base, input);
    assert.equal(created.status, 201);
    const s = await created.json();
    assert.equal((await (await app.request(base)).json()).length, 1);
    // The crew page reads every member's schedules in one request.
    assert.deepEqual((await (await app.request("/api/crew/schedules")).json()).map((x: { id: string; agentId: string }) => [x.id, x.agentId]), [[s.id, "a-tests"]]);
    assert.equal((await post(`${base}/${s.id}`, { ...input, preApprove: false, enabled: false })).status, 200);
    assert.equal(store.listCrewSchedules()[0]!.preApprove, false);
    assert.equal((await post(`${base}/missing`, input)).status, 400);
    assert.equal((await app.request(`${base}/${s.id}`, { method: "DELETE" })).status, 200);
    assert.equal(store.listCrewSchedules().length, 0);
  } finally { store.close(); }
});
