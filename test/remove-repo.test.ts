import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";

function setup() {
  const store = new Store(":memory:");
  const app = store.addRepo({ path: "/app", name: "app" });
  const factory = store.addRepo({ path: "/factory", name: "crane", isFactory: true });
  return { store, actions: new OperatorActions(store), app, factory };
}

test("removeRepo: disconnects a repo, keeps the factory's own, and ignores an unknown id", (t) => {
  const { store, actions, app, factory } = setup();
  t.after(() => store.close());

  actions.removeRepo("r-missing");
  actions.removeRepo(factory.id);
  assert.deepEqual(store.listRepos().map((r) => r.id).sort(), [app.id, factory.id].sort());

  actions.removeRepo(app.id);
  assert.equal(store.getRepo(app.id), null);
  assert.deepEqual(store.listRepos().map((r) => r.id), [factory.id]);
});

test("api: removing a repo answers ok whether or not anything changed", async (t) => {
  const { store, app, factory } = setup();
  t.after(() => store.close());
  const server = createApp(store);
  const remove = (id: string) => server.request(`/api/repos/${id}`, { method: "DELETE" });

  for (const id of ["r-missing", factory.id, app.id]) {
    const response = await remove(id);
    assert.equal(response.status, 200, id);
    assert.deepEqual(await response.json(), { ok: true }, id);
  }
  assert.deepEqual(store.listRepos().map((r) => r.id), [factory.id]);
});
