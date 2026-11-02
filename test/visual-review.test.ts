import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report, VisualReview } from "@crane/contracts";
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

function setup(path = ":memory:") {
  const store = new Store(path);
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: "/repo" });
  const task = store.createTask({ kind: "maintenance", title: "UI", brief: "", repoId: repo.id, autonomy: "propose", preApprove: true });
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

test("visual review: pre-approval and successful checks never substitute for an operator decision", async () => {
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

test("visual review: unknown legacy status holds automatic merge; explicit non-UI classification preserves it", () => {
  for (const visualReview of [null, pending, { ...pending, status: "not_required" as const }]) {
    const { store, task } = setup();
    try {
      store.updateTask(task.id, { visualReview });
      assert.equal(store.finishWork(task.id, "needs_review"), visualReview?.status === "not_required" ? "merging" : "needs_review");
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

test("visual review: gate holds changed merge trees and conflicts; same reviewed content can be rebuilt", async () => {
  const { store, actions, task } = setup();
  try {
    store.finishWork(task.id, "needs_review");
    await actions.recordVisualReview(task.id, { status: "waived", commit, note: "Urgent fix; task view unreviewed at all sizes" });
    requireCandidateVisualReview(store, task.id, "c".repeat(40), tree, commit, []);
    const next = "d".repeat(40);
    const nextTree = "e".repeat(40);
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, commit, []), /visual inspection/);
    assert.deepEqual(store.getTask(task.id)!.visualReview, { status: "pending", commit: next, tree: nextTree, decidedAt: null,
      note: "Inspect this candidate before merging, or explicitly waive visual review. The candidate may have changed during merging." });
    await actions.recordVisualReview(task.id, { status: "inspected", commit: next, note: "Inspected merged candidate at all sizes; screenshot paths recorded" });
    requireCandidateVisualReview(store, task.id, "f".repeat(40), nextTree, commit, []);
    store.updateTask(task.id, { visualReview: { ...pending, status: "not_required" } });
    requireCandidateVisualReview(store, task.id, next, nextTree, commit, []);
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, next, []), /visual inspection/, "stale non-UI classifications cannot authorize changed branches");
    store.updateTask(task.id, { visualReview: { ...pending, status: "not_required" } });
    assert.throws(() => requireCandidateVisualReview(store, task.id, next, nextTree, commit, ["src/App.tsx"]), /visual inspection/, "UI introduced during conflict resolution requires a decision");
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
