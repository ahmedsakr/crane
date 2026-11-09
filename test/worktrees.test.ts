import "../src/application.js";
import { test, type TestContext } from "node:test";
import { temporaryRoot, onFixtureCleanup, testHome } from "./support/fixtures.js";
import assert from "node:assert/strict";
import { sh } from "./support/git.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { Factory } from "@crane/factory/runtime";
import { createWorktree } from "../packages/factory/src/git.js";
import { SimulatedDriver } from "@crane/agent-drivers";
import type { AgentDriver } from "@crane/agent-protocol";
import type { Report } from "@crane/contracts";

async function setup(ctx: TestContext) {
  testHome(ctx);
  const root = temporaryRoot(ctx, "crane-worktrees-");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  onFixtureCleanup(ctx, () => store.close());
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "worktrees");
  store.setRepoChecks(repo.id, ["true"]);
  return { store, actions, repo, checkout };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("worktrees: missing prerequisite and unchanged pre-approved branch stop before checks and automatic merge", async (ctx) => {
  for (const status of ["blocked", "incomplete", "completed", "already_satisfied"] as const) {
    const { store, actions, repo, checkout } = await setup(ctx);
    const main = sh(checkout, "rev-parse", "main");
    const task = actions.createTask({ kind: "maintenance", title: "Needs absent setup", brief: "", repoId: repo.id, autonomy: "propose", preApprove: true });
    const completion: NonNullable<Report["completion"]> = { status,
      reason: status === "already_satisfied" ? "Existing README delivers the requested note" : "Required package is absent; implementation stopped",
      evidence: status === "already_satisfied" ? `README.md at ${main}` : "No required package in this checkout" };
    const driver: AgentDriver = { name: "test", label: "Test", available: async () => true,
      run: async () => ({ report: { summary: "No changes", findings: [], changedFiles: ["invented.ts"], completion,
        visualReview: { required: false, reason: "No UI changes" }, hasContribution: true } }) };
    // A check would fail if reached. Completion holds must skip it entirely.
    store.setRepoChecks(repo.id, ["exit 42"]);
    const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10, buildDashboard: false });
    const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
    factory.start();
    try {
      await until(() => store.getTask(task.id)?.status === "needs_review", "completion hold");
      const held = store.getTask(task.id)!;
      assert.equal(held.report?.hasContribution, false, "Git overrides invented agent contribution evidence");
      assert.deepEqual(held.report?.completion, completion);
      assert.deepEqual(held.report?.validation, [], "review checks were skipped");
      assert.equal(sh(checkout, "rev-parse", held.branch!), main, "the branch made no new commit");
      assert.equal(store.claimNextMerge("a-boom"), null);
      assert.ok(store.listEvents(task.id).some(e => e.data?.completionHold));
      assert.equal(store.listEvents(task.id).some(e => e.message.startsWith("Review check")), false);
      if (status === "already_satisfied") {
        assert.equal((await actions.approve(task.id, `Accepted README evidence at ${main}`, { merge: false })).status, "approved");
      }
    } finally { await stopFactory(); }
  }
});

test("worktrees: a cancelled task's unfinished work goes to its branch, and its worktree is removed", async (ctx) => {
  const { store, actions, repo, checkout } = await setup(ctx);
  const t = actions.createTask({ kind: "maintenance", title: "Half a change", brief: "", repoId: repo.id, autonomy: "propose" });
  const factory = new Factory(store, new SimulatedDriver(200), { crewSize: 1, tickMs: 10 });
  const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
  factory.start();
  try {
    await until(() => !!store.getTask(t.id)?.sessionId, "the agent's session to start");
    const { worktree: wt, branch } = store.getTask(t.id)!;
    writeFileSync(join(wt!, "progress.txt"), "half done\n");
    actions.cancel(t.id);

    await until(() => !existsSync(wt!) && store.getTask(t.id)!.worktree === null, "the worktree to be removed");
    const done = store.getTask(t.id)!;
    assert.equal(done.status, "cancelled");
    assert.equal(done.branch, branch, "the branch is kept");
    assert.equal(sh(checkout, "show", `${branch}:progress.txt`), "half done", "the unfinished work is on the branch");
    assert.ok(!sh(checkout, "worktree", "list").includes(wt!), "git no longer lists it");
    assert.ok(
      store.listEvents(t.id).some((e) => e.message === `Saved its unfinished work to ${branch} and removed its worktree`),
      store.listEvents(t.id).map((e) => e.message).join("\n"),
    );
  } finally {
    await stopFactory();
  }
});

test("worktrees: leftovers of finished tasks go, while open tasks and work that can't be saved stay", async (ctx) => {
  const { store, actions, repo, checkout } = await setup(ctx);
  const make = async (title: string) => {
    const t = actions.createTask({ kind: "maintenance", title, brief: "", repoId: repo.id, autonomy: "propose" });
    const wt = await createWorktree(repo, t);
    store.updateTask(t.id, { branch: wt.branch, worktree: wt.path });
    return { id: t.id, ...wt };
  };

  // Merged, but the factory stopped before removing the worktree: the task no longer records it.
  const merged = await make("Merged already");
  store.updateTask(merged.id, { worktree: null });
  store.setStatus(merged.id, "merged", "Merged into main");

  // Failed with nothing uncommitted.
  const failed = await make("Clean failure");
  store.setStatus(failed.id, "failed", "Failed");

  // Failed with changes, but off its branch, so committing them could land them anywhere.
  const detached = await make("Detached failure");
  sh(detached.path, "checkout", "-q", "--detach");
  writeFileSync(join(detached.path, "notes.txt"), "keep me\n");
  store.setStatus(detached.id, "failed", "Failed");

  // Still waiting for the operator.
  const review = await make("Waiting for review");
  store.setStatus(review.id, "needs_review", "Ready for your review");

  // A bad record that points at the operator's own checkout must never be touched.
  writeFileSync(join(checkout, "mine.txt"), "operator's work\n");
  const odd = actions.createTask({ kind: "maintenance", title: "Odd record", brief: "", repoId: repo.id, autonomy: "propose" });
  store.updateTask(odd.id, { branch: "main", worktree: checkout });
  store.setStatus(odd.id, "cancelled", "Cancelled");
  const mainBefore = sh(checkout, "rev-parse", "main");

  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
  factory.start();
  try {
    await until(() => !existsSync(merged.path) && !existsSync(failed.path), "finished worktrees to be removed");
  } finally {
    await stopFactory();
  }

  assert.equal(store.getTask(failed.id)!.worktree, null);
  assert.ok(sh(checkout, "branch", "--list", failed.branch), "a failed task keeps its branch");

  assert.ok(existsSync(detached.path), "work that can't be saved stays where it is");
  assert.equal(readFileSync(join(detached.path, "notes.txt"), "utf8"), "keep me\n");
  assert.equal(store.getTask(detached.id)!.worktree, detached.path);

  assert.ok(existsSync(review.path), "a task under review keeps its worktree");
  assert.equal(store.getTask(review.id)!.worktree, review.path);

  assert.ok(existsSync(checkout));
  assert.equal(sh(checkout, "rev-parse", "main"), mainBefore, "nothing was committed to the operator's branch");
  assert.equal(readFileSync(join(checkout, "mine.txt"), "utf8"), "operator's work\n");
});
