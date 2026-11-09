import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport } from "@crane/agent-protocol";
import type { Report } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";

const completed: NonNullable<Report["completion"]> = { status: "completed", reason: "Implemented", evidence: "Feature-specific tests" };

test("completion: parser preserves outcomes but ignores agent contribution claims", () => {
  const parse = (completion: unknown) => parseReport("```crane-report\n" + JSON.stringify({ completion, hasContribution: true }) + "\n```");
  for (const status of ["completed", "blocked", "incomplete", "already_satisfied"] as const) {
    const completion = { ...completed, status };
    assert.deepEqual(parse(completion).completion, completion);
    assert.equal(parse(completion).hasContribution, undefined);
  }
  for (const completion of [null, "completed", {}, { ...completed, status: "done" }, { ...completed, status: ["completed"] }, { ...completed, reason: " " },
    { ...completed, evidence: null }, { ...completed, status: "already_satisfied", evidence: " " }]) {
    assert.equal(parse(completion).completion, undefined);
  }
});

test("completion: pre-approved incomplete or empty implementation waits independently of findings and acceptance", async () => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  try {
    for (const autonomy of ["propose", "act"] as const) {
      for (const completion of [undefined, { ...completed, status: "blocked" as const, reason: "Required package is missing" },
        { ...completed, status: "incomplete" as const }, { ...completed, status: "already_satisfied" as const }, completed]) {
        const task = store.createTask({ kind: "maintenance", title: "Implement", brief: "", repoId: repo.id, autonomy, preApprove: true });
        store.updateTask(task.id, { status: "running", branch: `crane/${task.id}`,
          report: { summary: "Stopped", findings: [], changedFiles: [], completion, hasContribution: completion?.status !== "completed" },
          visualReview: { status: "not_required", commit: "test", tree: "test", note: "Backend only", decidedAt: null } });
        assert.equal(store.finishWork(task.id, "done"), "needs_review");
        assert.equal(store.claimNextMerge("a-jib"), null);
        assert.ok(store.listEvents(task.id).at(-1)?.data?.completionHold);
        assert.deepEqual(store.getTask(task.id)?.report?.completion, completion);
        if (completion?.status === "already_satisfied") {
          assert.equal((await actions.approve(task.id, "Accepted existing feature-specific evidence", { merge: false })).status, "approved");
        }
      }
    }
    const delivered = store.createTask({ kind: "maintenance", title: "Delivered", brief: "", repoId: repo.id, autonomy: "propose", preApprove: true });
    store.updateTask(delivered.id, { status: "running", branch: "crane/delivered",
      report: { summary: "Delivered", findings: [], changedFiles: [], completion: completed, hasContribution: true },
      visualReview: { status: "not_required", commit: "test", tree: "test", note: "Backend only", decidedAt: null } });
    assert.equal(store.finishWork(delivered.id, "needs_review"), "merging");
  } finally { store.close(); }
});
