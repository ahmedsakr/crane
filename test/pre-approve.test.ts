import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import type { Autonomy } from "@crane/contracts";

function setup() {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const make = (autonomy: Autonomy = "propose") =>
    store.createTask({ kind: "maintenance", title: `Task ${autonomy}`, brief: "", repoId: repo.id, autonomy });
  return { store, actions, repo, make };
}

test("pre-approve: only queued or running tasks that change code, once, and it can be undone", () => {
  const { store, actions, make } = setup();
  try {
    const t = make();
    const pre = actions.preApprove(t.id, "Ship it");
    assert.ok(pre.preApprovedAt, "recorded on the task");
    assert.ok(store.listEvents(t.id).some((e) => e.type === "operator" && e.message === "Pre-approved: Ship it"));
    assert.throws(() => actions.preApprove(t.id), /already pre-approved/);

    store.setStatus(t.id, "running");
    const undone = actions.undoPreApproval(t.id);
    assert.equal(undone.preApprovedAt, null);
    assert.ok(store.listEvents(t.id).some((e) => e.type === "operator" && /^Undid pre-approval/.test(e.message)));
    assert.throws(() => actions.undoPreApproval(t.id), /isn't pre-approved/);
    assert.ok(actions.preApprove(t.id).preApprovedAt, "running tasks can be pre-approved too");

    const observe = make("observe");
    assert.throws(() => actions.preApprove(observe.id), /investigate-only/);
    assert.equal(store.getTask(observe.id)!.preApprovedAt, null);

    const review = make();
    store.setStatus(review.id, "needs_review");
    assert.throws(() => actions.preApprove(review.id), /already waiting for review. Approve it instead/);

    for (const status of ["failed", "cancelled", "merged", "done"] as const) {
      const over = make();
      store.setStatus(over.id, status);
      const events = store.listEvents(over.id);
      assert.throws(() => actions.preApprove(over.id), /isn't queued or running/, status);
      assert.equal(store.getTask(over.id)!.preApprovedAt, null, status);
      assert.deepEqual(store.listEvents(over.id), events, `${status}: no decision recorded`);
    }
    assert.throws(() => actions.preApprove(t.id, 42 as unknown as string), /Note must be text/);
  } finally { store.close(); }
});

test("pre-approve: a finished run goes to the merge queue instead of review, unless it can't", () => {
  const { store, actions, make } = setup();
  try {
    // Pre-approved with a branch: straight to merging, free for any agent to claim.
    const yes = make();
    actions.preApprove(yes.id);
    store.claimNextTask("a-jib");
    store.updateTask(yes.id, { branch: `crane/${yes.id}` });
    assert.equal(store.finishWork(yes.id, "needs_review"), "merging");
    const merging = store.getTask(yes.id)!;
    assert.equal(merging.status, "merging");
    assert.equal(merging.agentId, null);
    assert.ok(merging.finishedAt, "queued by when its work finished");
    assert.match(store.listEvents(yes.id).at(-1)!.message, /Waiting to merge into main, as you pre-approved/);
    assert.equal(store.claimNextMerge("a-boom")?.id, yes.id);

    // "Change on a branch" tasks finish as done; pre-approved ones merge too.
    const act = make("act");
    actions.preApprove(act.id);
    store.updateTask(act.id, { branch: `crane/${act.id}` });
    assert.equal(store.finishWork(act.id, "done"), "merging");

    // Not pre-approved, or undone: review as usual.
    const no = make();
    store.updateTask(no.id, { branch: `crane/${no.id}` });
    assert.equal(store.finishWork(no.id, "needs_review"), "needs_review");
    const undone = make();
    actions.preApprove(undone.id);
    actions.undoPreApproval(undone.id);
    store.updateTask(undone.id, { branch: `crane/${undone.id}` });
    assert.equal(store.finishWork(undone.id, "needs_review"), "needs_review");

    // No branch means nothing to merge, so it waits for review.
    const branchless = make();
    actions.preApprove(branchless.id);
    assert.equal(store.finishWork(branchless.id, "needs_review"), "needs_review");

    // Cancelled while finishing: left alone.
    const cancelled = make();
    actions.preApprove(cancelled.id);
    store.updateTask(cancelled.id, { branch: `crane/${cancelled.id}` });
    actions.cancel(cancelled.id);
    assert.equal(store.finishWork(cancelled.id, "needs_review"), null);
    assert.equal(store.getTask(cancelled.id)!.status, "cancelled");

    // Once the run has handed over, the pre-approval can't be taken back.
    assert.throws(() => actions.undoPreApproval(yes.id), /already finished its run/);
  } finally { store.close(); }
});

test("pre-approve: the API pre-approves and undoes, and rejects bad bodies without changing anything", async () => {
  const { store, make } = setup();
  try {
    const app = createApp(store);
    const t = make();
    for (const body of ["{", "null", "[]", "42", JSON.stringify({ note: 42 })]) {
      const before = store.getTask(t.id);
      const events = store.listEvents(t.id);
      const response = await app.request(`/api/tasks/${t.id}/pre-approve`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      assert.equal(response.status, 400, body);
      assert.deepEqual(store.getTask(t.id), before, body);
      assert.deepEqual(store.listEvents(t.id), events, body);
    }
    const ok = await app.request(`/api/tasks/${t.id}/pre-approve`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).preApprovedAt);
    const undo = await app.request(`/api/tasks/${t.id}/pre-approve`, { method: "DELETE" });
    assert.equal(undo.status, 200);
    assert.equal((await undo.json()).preApprovedAt, null);
    const again = await app.request(`/api/tasks/${t.id}/pre-approve`, { method: "DELETE" });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /isn't pre-approved/);
  } finally { store.close(); }
});
