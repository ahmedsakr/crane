import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoalPlan, Overview } from "@crane/contracts";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { SiteModel } from "../web/src/lib/site.ts";

const FACTORY: Overview["factory"] = {
  running: true, paused: false, driver: "simulated", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null,
};

function setup() {
  const store = new Store(":memory:");
  const repo = store.addRepo({ path: "/home-site-repo" });
  const actions = new OperatorActions(store);
  const goal = actions.createGoal({ repoId: repo.id, outcome: "Deliver a large goal", driver: "simulated" });
  const task = () => store.createTask({ kind: "maintenance", title: "Standalone task", brief: "", repoId: repo.id, autonomy: "observe" });
  return { store, actions, goal, task };
}

function largePlan(): GoalPlan {
  return {
    summary: "Deliver in order", approach: "Start with the shared contract", improvements: [],
    tasks: Array.from({ length: 30 }, (_, i) => ({
      key: `step-${i}`, title: `Goal task ${i}`, brief: "Deliver this step", dependsOn: i ? ["step-0"] : [],
      driver: "simulated", model: null, effort: null, rationale: "Use the shared contract", acceptance: ["Step delivered"],
    })),
  };
}

test("Home keeps researching goals visible behind a newer queue", () => {
  const { store, goal, task } = setup();
  try {
    assert.equal(store.claimNextTask("a-research")!.id, goal.researchTaskId);
    for (let i = 0; i < 30; i++) task();
    const overview = store.overview(FACTORY);
    const site = new SiteModel();
    site.sync(overview.inFlight);
    assert.equal(overview.inFlight[0]!.id, goal.researchTaskId);
    assert.equal(site.payloads.get(goal.researchTaskId)?.zone, "working");
    assert.equal(overview.inFlight.filter((t) => t.status === "queued").length, 20);
  } finally { store.close(); }
});

test("Home's API and crane track early goal tasks through a large plan's queue", async () => {
  const { store, actions, goal, task } = setup();
  try {
    store.updateTask(goal.researchTaskId, { status: "needs_review", report: {
      summary: "Plan ready", findings: [], changedFiles: [], goalPlan: largePlan(),
      completion: { status: "completed", reason: "Research complete", evidence: "Plan prepared" },
    } });
    store.syncGoals();
    const approved = actions.approveGoal(goal.id, store.getGoal(goal.id)!.revision);
    const first = store.claimNextTask("a-goal")!;
    assert.equal(first.id, approved.tasks[0]!.taskId);
    const standalone = task();
    store.updateTask(standalone.id, { status: "running" });
    const queued = store.listTaskSummaries({ status: ["queued"], limit: 20 });
    const site = new SiteModel({ instant: true });
    for (const status of ["running", "merging", "needs_review", "merged"] as const) {
      store.updateTask(first.id, { status });
      // A fresh app avoids the overview's one-second polling cache.
      const response = await createApp(store).request("/api/overview");
      assert.equal(response.status, 200);
      const overview = await response.json() as Overview;
      site.sync([...overview.inFlight, ...overview.needsReview, ...overview.recent]);
      assert.deepEqual(overview.inFlight.filter((t) => t.status === "queued"), queued);
      assert.equal(site.payloads.get(first.id)?.task.title, first.title);
      assert.equal(site.payloads.get(standalone.id)?.zone, "working");
      const zone = { running: "working", merging: "merging", needs_review: "review", merged: "shipped" }[status];
      assert.equal(site.payloads.get(first.id)?.zone, zone);
      assert.equal(site.payloads.get(first.id)?.leaving, false);
      assert.equal(new Set(overview.inFlight.map((t) => t.id)).size, overview.inFlight.length);
    }
  } finally { store.close(); }
});

test("Home never caps running work or merges, while its queued preview stays bounded", () => {
  const { store, task } = setup();
  try {
    const running = Array.from({ length: 25 }, task);
    for (const t of running) store.updateTask(t.id, { status: "running" });
    const merging = Array.from({ length: 3 }, task);
    for (const t of merging) store.updateTask(t.id, { status: "merging" });
    const queued = Array.from({ length: 30 }, task);
    const overview = store.overview(FACTORY);
    assert.equal(overview.inFlight.length, 48);
    assert.deepEqual(new Set(overview.inFlight.filter((t) => t.status !== "queued").map((t) => t.id)),
      new Set([...running, ...merging].map((t) => t.id)));
    assert.deepEqual(new Set(overview.inFlight.filter((t) => t.status === "queued").map((t) => t.id)),
      new Set(queued.slice(-20).map((t) => t.id)));
  } finally { store.close(); }
});
