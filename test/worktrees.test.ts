import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { createWorktree } from "../src/factory/git.js";
import { SimulatedDriver } from "../src/agents/simulated.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-worktrees-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "worktrees");
  store.setRepoChecks(repo.id, ["true"]);
  return { store, actions, repo, checkout };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("worktrees: a cancelled task's unfinished work goes to its branch, and its worktree is removed", async () => {
  const { store, actions, repo, checkout } = await setup();
  const t = actions.createTask({ kind: "maintenance", title: "Half a change", brief: "", repoId: repo.id, autonomy: "propose" });
  const factory = new Factory(store, new SimulatedDriver(200), { crewSize: 1, tickMs: 10 });
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
    await factory.stop();
    store.close();
  }
});

test("worktrees: leftovers of finished tasks go, while open tasks and work that can't be saved stay", async () => {
  const { store, actions, repo, checkout } = await setup();
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
  factory.start();
  try {
    await until(() => !existsSync(merged.path) && !existsSync(failed.path), "finished worktrees to be removed");
  } finally {
    await factory.stop();
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
  store.close();
});
