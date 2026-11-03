import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visualReviewPending, type Report, type VisualReview } from "@crane/contracts";
import { parseReport } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { createApp } from "../src/server/app.js";
import { requireCandidateVisualReview, visualReviewRequired } from "../src/factory/visual-review.js";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const pending: VisualReview = { status: "pending", commit, tree, note: "UI changed; browser review outstanding", decidedAt: null };
const report: Report = { summary: "Done", findings: [], changedFiles: ["src/server.ts"],
  completion: { status: "completed", reason: "Implemented", evidence: "Implementation tests" }, hasContribution: true };

function setup(path = ":memory:", preApprove = false, acceptance: string[] = []) {
  const store = new Store(path);
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "UI", brief: "", repoId: repo.id, autonomy: "propose", preApprove, acceptance });
  store.updateTask(task.id, { status: "running", branch: "crane/ui", report, visualReview: pending });
  return { store, actions, task };
}

test("visual review: missing or malformed classifications fail closed; agents cannot supply decisions", () => {
  for (const visualReview of [undefined, { status: "waived", commit, note: "trust me" }, { required: "false", reason: "backend" }, { required: false, reason: " " }]) {
    const parsed = parseReport("```crane-report\n" + JSON.stringify({ ...report, visualReview }) + "\n```");
    assert.equal(parsed.visualReview, undefined);
    assert.equal(visualReviewRequired(parsed), true);
  }
  const parsed = parseReport("```crane-report\n" + JSON.stringify({ ...report, visualReview: { required: false, reason: "Backend only", status: "waived" } }) + "\n```");
  assert.deepEqual(parsed.visualReview, { required: false, reason: "Backend only" });
  assert.equal(visualReviewRequired(parsed), false);
  for (const file of ["web/src/api.ts", "src/App.tsx", "app/page.jsx", "styles/app.css", "index.html", "src/App.vue", "public/icon.svg"]) {
    assert.equal(visualReviewRequired({ ...parsed, changedFiles: [file] }), true, file);
  }
  assert.equal(visualReviewRequired({ ...parsed, screenshots: [{ path: "x.png", caption: "UI" }] }), true);
});

test("visual review: ordinary approval and successful checks never substitute for an operator decision", async () => {
  const { store, actions, task } = setup();
  try {
    assert.equal(store.finishWork(task.id, "needs_review"), "needs_review");
    assert.equal(store.claimNextMerge("a-jib"), null);
    await assert.rejects(actions.approve(task.id, "Pre-approved, ship it"), /visual inspection/);
    await assert.rejects(actions.approve(task.id, "I waive review", { merge: false }), /visual inspection/);
    assert.equal(store.listEvents(task.id).some(e => e.message.startsWith("Approved")), false);
    await assert.rejects(actions.recordVisualReview(task.id, { status: "waived", commit, note: " " }), /waiver reason/);
    await assert.rejects(actions.recordVisualReview(task.id, { status: "inspected", commit: "c".repeat(40), note: "all sizes" }), /candidate changed/);
    assert.equal(store.getTask(task.id)!.visualReview!.status, "pending");
    await actions.recordVisualReview(task.id, { status: "inspected", commit, note: "/tasks: wide 1280x800, short 1280x600, phone 390x844; screenshots/task-*.png; no overflow" });
    assert.equal(store.getTask(task.id)!.status, "needs_review", "a visual decision is not approval");
    assert.equal((await actions.approve(task.id)).status, "merging");
    const decision = store.listEvents(task.id).find(e => e.message === "Recorded candidate visual inspection");
    assert.equal((decision?.data?.visualReview as VisualReview).commit, commit);
  } finally { store.close(); }
});

test("visual review: explicit waiver persists across restart and retry requires a fresh decision", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crane-visual-")), "test.db");
  const { store, actions, task } = setup(path);
  store.finishWork(task.id, "needs_review");
  await actions.recordVisualReview(task.id, { status: "waived", commit, note: "Operator accepts risk: task page unreviewed at all three sizes; urgent repair" });
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.getTask(task.id)!.visualReview!.status, "waived");
    assert.ok(reopened.getTask(task.id)!.visualReview!.decidedAt);
    const ops = new OperatorActions(reopened);
    assert.equal(ops.retry(task.id).visualReview, null);
    assert.equal((await ops.approve(task.id, undefined, { merge: false })).status, "approved");
    assert.equal((await ops.merge(task.id)).status, "merging");
  } finally { reopened.close(); }
});

test("visual review: pre-approval waives pending candidates and allows legacy candidates to reach the merge gate", () => {
  for (const visualReview of [null, pending, { ...pending, status: "not_required" as const }]) {
    const { store, task } = setup(":memory:", true);
    try {
      store.updateTask(task.id, { visualReview });
      assert.equal(visualReviewPending(store.getTask(task.id)!), false);
      assert.equal(store.finishWork(task.id, "needs_review"), "merging");
      if (visualReview?.status === "pending") {
        const review = store.getTask(task.id)!.visualReview!;
        assert.equal(review.status, "waived");
        assert.equal(review.commit, commit);
        assert.equal(review.tree, tree);
        assert.ok(review.decidedAt);
        const event = store.listEvents(task.id).find(e => e.message === "Visual review waived by pre-approval");
        assert.deepEqual(event?.data?.visualReview, review);
        assert.equal(event?.data?.preApprovedAt, task.preApprovedAt);
      }
      requireCandidateVisualReview(store, task.id, "c".repeat(40), "d".repeat(40), commit, ["web/src/App.tsx"], true);
      assert.equal(store.getTask(task.id)!.visualReview!.status, "waived", "UI conflict resolutions are covered too");
    } finally { store.close(); }
  }
});

test("visual review: pre-approval during a run applies, and undo restores candidate review", () => {
  for (const undo of [false, true]) {
    const { store, actions, task } = setup();
    try {
      actions.preApprove(task.id);
      if (undo) actions.undoPreApproval(task.id);
      assert.equal(visualReviewPending(store.getTask(task.id)!), undo);
      assert.equal(store.finishWork(task.id, "needs_review"), undo ? "needs_review" : "merging");
      if (undo) {
        assert.equal(store.getTask(task.id)!.visualReview!.status, "pending");
        assert.throws(() => requireCandidateVisualReview(store, task.id, commit, tree, commit, ["web/src/App.tsx"]), /visual inspection/);
        assert.equal(store.listEvents(task.id).some(e => e.message === "Visual review waived by pre-approval"), false);
      }
    } finally { store.close(); }
  }
});

test("visual review: automatic waivers persist and retry requires fresh consent", () => {
  const path = join(mkdtempSync(join(tmpdir(), "crane-visual-pre-")), "test.db");
  const { store, task } = setup(path, true);
  store.finishWork(task.id, "needs_review");
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.getTask(task.id)!.visualReview!.status, "waived");
    const retry = new OperatorActions(reopened).retry(task.id);
    assert.equal(retry.preApprovedAt, null);
    assert.equal(retry.visualReview, null);
  } finally { reopened.close(); }
});

test("visual review: failed automatic waiver events roll back handover and decision", () => {
  const { store, task } = setup(":memory:", true);
  try {
    store.db.exec(`CREATE TRIGGER reject_automatic_waiver BEFORE INSERT ON events
      WHEN NEW.message = 'Visual review waived by pre-approval' BEGIN SELECT RAISE(ABORT, 'event failed'); END`);
    assert.throws(() => store.finishWork(task.id, "needs_review"), /event failed/);
    assert.equal(store.getTask(task.id)!.visualReview!.status, "pending");
    assert.equal(store.getTask(task.id)!.status, "running");
  } finally { store.close(); }
});

test("visual review: a pre-approved visual waiver does not waive completion or acceptance holds", () => {
  for (const hold of ["completion", "contribution", "acceptance"] as const) {
    const { store, task } = setup(":memory:", true, hold === "acceptance" ? ["Greeting is accessible"] : []);
    try {
      const reports = {
        acceptance: { ...report, acceptance: [] },
        contribution: { ...report, hasContribution: false },
        completion: { ...report, completion: { status: "incomplete" as const, reason: "Greeting not implemented", evidence: "Missing component" } },
      };
      store.updateTask(task.id, { report: reports[hold] });
      assert.equal(store.finishWork(task.id, "done"), "needs_review");
      assert.equal(store.getTask(task.id)!.visualReview!.status, "waived");
      assert.equal(store.claimNextMerge("a-jib"), null);
      const event = store.listEvents(task.id).at(-1)!;
      assert.ok(hold === "acceptance" ? event.data?.acceptanceUnmet : event.data?.completionHold);
    } finally { store.close(); }
  }
});

test("visual review: migration leaves old tasks held and decision-event failures roll back the decision", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crane-visual-old-")), "test.db");
  const { store, task } = setup(path);
  store.db.exec("ALTER TABLE tasks DROP COLUMN visual_review");
  store.close();
  const migrated = new Store(path);
  try {
    assert.equal(migrated.getTask(task.id)!.visualReview, null);
    assert.equal(migrated.finishWork(task.id, "needs_review"), "needs_review");
    migrated.updateTask(task.id, { visualReview: pending });
    migrated.db.exec(`CREATE TRIGGER reject_visual_decision BEFORE INSERT ON events
      WHEN NEW.message = 'Waived candidate visual review' BEGIN SELECT RAISE(ABORT, 'event failed'); END`);
    await assert.rejects(new OperatorActions(migrated).recordVisualReview(task.id, { status: "waived", commit, note: "Urgent; all views unreviewed" }), /event failed/);
    assert.equal(migrated.getTask(task.id)!.visualReview!.status, "pending");
  } finally { migrated.close(); }
});

test("visual review: a decision carries across a clean merge onto a newer default branch", async () => {
  for (const status of ["waived", "inspected"] as const) {
    const { store, actions, task } = setup();
    try {
      store.finishWork(task.id, "needs_review");
      await actions.recordVisualReview(task.id, { status, commit, note: "Task view at all sizes" });
      const decided = store.getTask(task.id)!.visualReview;
      requireCandidateVisualReview(store, task.id, "c".repeat(40), tree, commit, [], false);
      // The task's own UI files are what the decision was about, so they don't reopen it.
      requireCandidateVisualReview(store, task.id, "d".repeat(40), "e".repeat(40), commit, ["web/src/App.tsx"]);
      assert.deepEqual(store.getTask(task.id)!.visualReview, decided);
    } finally { store.close(); }
  }
});

test("visual review: new branch commits and UI conflict resolutions need a fresh decision, once", async () => {
  const { store, actions, task } = setup();
  const merged = "d".repeat(40);
  const mergedTree = "e".repeat(40);
  try {
    store.finishWork(task.id, "needs_review");
    await actions.recordVisualReview(task.id, { status: "waived", commit, note: "Urgent fix; task view unreviewed at all sizes" });
    assert.throws(() => requireCandidateVisualReview(store, task.id, merged, mergedTree, commit, [], true), /visual inspection/);
    assert.deepEqual(store.getTask(task.id)!.visualReview, { status: "pending", commit: merged, tree: mergedTree, branchCommit: commit, decidedAt: null,
      note: "An agent changed UI files while resolving conflicts. Inspect this merge before it lands, or explicitly waive visual review." });

    await actions.recordVisualReview(task.id, { status: "inspected", commit: merged, note: "Inspected merged candidate at all sizes; screenshot paths recorded" });
    assert.equal(store.getTask(task.id)!.visualReview!.branchCommit, commit, "the decision remembers which branch it covers");
    requireCandidateVisualReview(store, task.id, "f".repeat(40), mergedTree, commit, [], true);
    requireCandidateVisualReview(store, task.id, "f".repeat(40), "1".repeat(40), commit, []);
    assert.equal(store.getTask(task.id)!.visualReview!.status, "inspected");

    assert.throws(() => requireCandidateVisualReview(store, task.id, "2".repeat(40), "3".repeat(40), "4".repeat(40), []), /visual inspection/, "the branch got new commits");
    assert.equal(store.getTask(task.id)!.visualReview!.note, "No visual decision covers these changes. Inspect this candidate before merging, or explicitly waive visual review.");
  } finally { store.close(); }
});

test("visual review: a non-UI classification holds for its branch, unless UI appears", () => {
  const { store, task } = setup();
  const next = "d".repeat(40);
  const nextTree = "e".repeat(40);
  const classify = () => store.updateTask(task.id, { visualReview: { ...pending, status: "not_required" } });
  try {
    classify();
    requireCandidateVisualReview(store, task.id, next, nextTree, commit, []);
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, next, []), /visual inspection/, "stale non-UI classifications cannot authorize changed branches");
    classify();
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, commit, ["src/App.tsx"]), /visual inspection/, "UI files in the merge require a decision");
    classify();
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, commit, [], true), /visual inspection/, "UI introduced during conflict resolution requires a decision");
  } finally { store.close(); }
});

test("visual review: API rejects malformed decisions and records an explicit waiver", async () => {
  const { store, task } = setup();
  store.finishWork(task.id, "needs_review");
  const app = createApp(store);
  const post = (body: unknown) => app.request(`/api/tasks/${task.id}/visual-review`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    for (const body of [{}, { status: "not_required", commit, note: "backend" }, { status: "waived", commit }, { status: "inspected", commit: "main", note: "looked" }]) {
      assert.equal((await post(body)).status, 400);
      assert.equal(store.getTask(task.id)!.visualReview!.status, "pending");
    }
    assert.equal((await post({ status: "waived", commit, note: "Urgent repair; task page unreviewed at all three sizes" })).status, 200);
    assert.equal(store.getTask(task.id)!.visualReview!.status, "waived");
  } finally { store.close(); }
});
