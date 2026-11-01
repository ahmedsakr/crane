import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { MAINTENANCE_ROLE } from "@crane/contracts";

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const factory = store.addRepo({ path: "/factory", name: "crane", isFactory: true });
  const other = store.addRepo({ path: "/other", name: "my-app" });
  store.upsertAgent({ id: "a-boom", name: "Boom", driver: "simulated" });
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  store.setSetting("crew_role_a-boom", "security");
  store.setSetting("crew_role_a-jib", "security");
  return { store, actions, factory, other };
}

test("role runs: repo selection preserves assignment and role; duplicate guard is per member and repo", async (t) => {
  const { store, actions, factory, other } = setup();
  t.after(() => store.close());
  const crane = await actions.runRole("a-boom");
  assert.equal(crane.repoId, factory.id, "omission still defaults to Crane");
  const app = await actions.runRole("a-boom", { repoId: other.name });
  assert.equal(app.repoId, other.id);
  assert.equal(app.assignee, "a-boom");
  assert.equal(app.autonomy, MAINTENANCE_ROLE.security.autonomy);
  assert.equal(app.kind, "maintenance");
  assert.equal(app.title, "Review security in my-app");
  assert.match(app.brief, /Boom's maintenance role: Security review/);
  assert.equal(store.listEvents(app.id).at(-1)?.data?.repoId, other.id);
  await assert.rejects(actions.runRole("a-boom", { repoId: other.id }), /already has a run under way/);
  store.updateTask(app.id, { status: "running" });
  await assert.rejects(actions.runRole("a-boom", { repoId: other.name }), /already has a run under way/);
  const jib = await actions.runRole("a-jib", { repoId: other.id });
  assert.equal(jib.assignee, "a-jib", "another member may run in the same repo");
  store.updateTask(app.id, { status: "needs_review" });
  assert.equal((await actions.runRole("a-boom", { repoId: other.id })).repoId, other.id);
});

test("role runs: an explicit repo works without a factory repo; invalid choices never fall back", async (t) => {
  const { store, actions, factory, other } = setup();
  t.after(() => store.close());
  store.db.prepare("DELETE FROM repos WHERE id = ?").run(factory.id);
  for (const repoId of ["missing", "", "  ", null, 42, {}, []]) {
    const app = createApp(store);
    const response = await app.request("/api/agents/a-boom/run", {
      method: "POST", body: JSON.stringify({ repoId }),
    });
    assert.equal(response.status, 400, JSON.stringify(repoId));
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.listRepos().length, 1, "invalid choices do not register the factory repo");
  }
  assert.equal((await actions.runRole("a-boom", { repoId: other.id })).repoId, other.id);
});

test("role runs: unrelated queued tasks cannot hide a member's existing run", async (t) => {
  const { store, actions, other } = setup();
  t.after(() => store.close());
  const run = await actions.runRole("a-boom", { repoId: other.id });
  store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", run.id);
  for (let i = 0; i < 201; i++) {
    store.createTask({ kind: "maintenance", title: `Other ${i}`, brief: "", repoId: other.id, autonomy: "observe" });
  }
  await assert.rejects(actions.runRole("a-boom", { repoId: other.id }), /already has a run under way/);
});

test("role runs: future runs retain the chosen repo and wait for their member and due time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-15T12:00:00Z") });
  const { store, actions, other } = setup();
  t.after(() => store.close());
  const run = await actions.runRole("a-boom", { repoId: other.id, scheduledAt: "2030-06-15T09:00-04:00" });
  assert.equal(run.scheduledAt, "2030-06-15T13:00:00.000Z");
  assert.equal(run.repoId, other.id);
  await assert.rejects(actions.runRole("a-boom", { repoId: other.id }), /already has a run under way/);
  assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true }), null);
  t.mock.timers.setTime(Date.parse(run.scheduledAt!));
  assert.equal(store.claimNextTask("a-jib", { onlyAssigned: true }), null);
  assert.equal(store.claimNextTask("a-boom", { onlyAssigned: true })?.id, run.id);
});

test("role run API: accepts empty bodies, selected repos and schedules; rejects malformed requests without tasks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-15T12:00:00Z") });
  const { store, factory, other } = setup();
  t.after(() => store.close());
  const app = createApp(store);
  const post = (body?: string) => app.request("/api/agents/a-boom/run", { method: "POST", body });
  for (const body of ["null", "[]", '"text"', "{", '{"scheduledAt":"yesterday"}', '{"scheduledAt":"2030-06-15T11:00Z"}']) {
    assert.equal((await post(body)).status, 400, body);
    assert.equal(store.listTasks().length, 0);
  }
  const defaultResponse = await post();
  assert.equal(defaultResponse.status, 201);
  assert.equal((await defaultResponse.json()).repoId, factory.id);
  const selectedResponse = await post(JSON.stringify({ repoId: other.id, scheduledAt: "2030-06-15T13:00Z" }));
  assert.equal(selectedResponse.status, 201);
  const selected = await selectedResponse.json();
  assert.equal(selected.repoId, other.id);
  assert.equal(selected.assignee, "a-boom");
  assert.equal(selected.scheduledAt, "2030-06-15T13:00:00.000Z");
  assert.equal((await post(JSON.stringify({ repoId: other.id }))).status, 400);
  assert.equal(store.listTasks().length, 2);
});
