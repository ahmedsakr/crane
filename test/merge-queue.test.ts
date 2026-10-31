import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";

test("merge queue: skips busy repos and claimed tasks, then takes the oldest available review", () => {
  const store = new Store(":memory:");
  try {
    const repos = ["first", "second", "third"].map(name => store.addRepo({ path: `/${name}` }));
    const tasks = repos.map((repo, i) => {
      const task = store.createTask({ kind: "maintenance", title: repo.name, brief: "", repoId: repo.id, autonomy: "propose" });
      store.updateTask(task.id, { status: "merging", finishedAt: `2026-01-0${3 - i}T00:00:00.000Z` });
      return task;
    });
    const busy = [repos[1]!.id, repos[2]!.id];
    const claimed = store.claimNextMerge("a-one", busy)!;
    assert.equal(claimed.id, tasks[0]!.id, "both busy repos are excluded even though their reviews are older");
    assert.equal(claimed.agentId, "a-one");
    assert.equal(claimed.status, "merging");
    assert.equal(store.claimNextMerge("a-two", busy), null);
    assert.equal(store.claimNextMerge("a-two")?.id, tasks[2]!.id, "finished time determines priority, not creation order");
    assert.equal(store.claimNextMerge("a-three")?.id, tasks[1]!.id);
    assert.equal(store.claimNextMerge("a-four"), null, "claimed merges cannot be claimed twice");
    assert.equal(store.claimNextTask("a-four"), null, "work claims leave merges alone");
    for (const task of tasks) {
      const pickups = store.listEvents(task.id).filter(e => e.message === "Picked up to merge");
      assert.equal(pickups.length, 1);
      assert.equal(pickups[0]!.data!.agentId, store.getTask(task.id)!.agentId);
    }
  } finally { store.close(); }
});
