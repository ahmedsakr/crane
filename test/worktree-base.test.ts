import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sh } from "./support/git.js";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatedDriver } from "@crane/agent-drivers";
import type { Autonomy, NewTask } from "@crane/contracts";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { Factory } from "@crane/factory/runtime";
import { createWorktree, diffForTask, finalizeWorktree, PreparationHold } from "../packages/factory/src/git.js";
import { siblingTasksFor } from "../packages/factory/src/task-context.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-base-home-"));

/** A checkout of main and a bare origin, in step. `other` is a second clone that pushes past the checkout. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-base-"));
  const checkout = join(root, "checkout");
  const origin = join(root, "origin.git");
  const other = join(root, "other");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  sh(checkout, "remote", "add", "origin", origin);
  sh(checkout, "push", "-q", "-u", "origin", "main");
  sh(root, "clone", "-q", origin, other);
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "base");
  store.setRepoChecks(repo.id, ["true"]);
  const make = (extra: Partial<NewTask> = {}, autonomy: Autonomy = "propose") =>
    actions.createTask({ kind: "maintenance", title: "Work", brief: "", repoId: repo.id, autonomy, ...extra });
  /** Land a commit on origin only, as a merge that left the operator's main behind does. */
  const landUpstream = (file: string) => {
    writeFileSync(join(other, file), "landed\n");
    sh(other, "add", file);
    sh(other, "commit", "-q", "-m", `land ${file}`);
    sh(other, "push", "-q", "origin", "HEAD:main");
    return sh(other, "rev-parse", "HEAD");
  };
  /** A finished prerequisite task that landed `commit`. */
  const landedTask = (commit: string | null, head?: string) => {
    const t = make({ title: "Prerequisite" });
    store.setStatus(t.id, "merged", "Merged into main", { merge: { commit, ...(head ? { head } : {}) } });
    return t;
  };
  return { store, actions, repo, checkout, origin, make, landUpstream, landedTask };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

const contains = (cwd: string, commit: string, target: string) => {
  try {
    sh(cwd, "merge-base", "--is-ancestor", commit, target);
    return true;
  } catch {
    return false;
  }
};

const messages = (store: Store, id: string) => store.listEvents(id).map((e) => e.message);

test("worktree base: a stale local main behind a dirty checkout doesn't hide what landed, and stays untouched", async () => {
  const { store, repo, checkout, make, landUpstream } = await setup();
  try {
    writeFileSync(join(checkout, "README.md"), "operator's edit\n");
    const before = { main: sh(checkout, "rev-parse", "main"), status: sh(checkout, "status", "--porcelain") };
    const landed = landUpstream("landed.txt");

    const notes: string[] = [];
    const t = make();
    const wt = await createWorktree(repo, t, { required: [{ id: "t-x", title: "X", commit: landed }], note: (m) => notes.push(m) });

    assert.equal(wt.base, landed);
    assert.equal(sh(wt.path, "rev-parse", "HEAD"), landed);
    assert.ok(notes.some((m) => m.includes("Starting from origin/main")), notes.join("\n"));
    assert.equal(sh(checkout, "rev-parse", "main"), before.main, "local main isn't moved");
    assert.equal(sh(checkout, "status", "--porcelain"), before.status, "the operator's changes are left alone");
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "operator's edit\n");

    // Upstream commits it started from aren't this task's changes, in any view of them.
    store.updateTask(t.id, { branch: wt.branch, worktree: wt.path });
    const task = store.getTask(t.id)!;
    assert.deepEqual((await siblingTasksFor(store, make(), repo)).find((s) => s.id === t.id)?.hasCommits, false, "a fresh branch has no commits of its own");
    writeFileSync(join(wt.path, "mine.txt"), "mine\n");
    store.setStatus(t.id, "running", "Running");
    const live = await diffForTask(repo, store.getTask(t.id)!);
    assert.equal(live.live, true);
    assert.ok(live.diff.includes("mine.txt") && !live.diff.includes("landed.txt"), live.diff);

    assert.deepEqual(await finalizeWorktree(repo, task, wt.path), ["mine.txt"]);
    store.setStatus(t.id, "needs_review", "Ready");
    const kept = await diffForTask(repo, store.getTask(t.id)!);
    assert.ok(kept.diff.includes("mine.txt") && !kept.diff.includes("landed.txt"), kept.diff);
  } finally { store.close(); }
});

test("worktree base: a local main with unpushed commits is the newest, so it's the base", async () => {
  const { store, repo, checkout, make } = await setup();
  try {
    writeFileSync(join(checkout, "local.txt"), "local\n");
    sh(checkout, "add", "local.txt");
    sh(checkout, "commit", "-q", "-m", "not pushed");
    const wt = await createWorktree(repo, make());
    assert.equal(wt.base, sh(checkout, "rev-parse", "main"));
  } finally { store.close(); }
});

test("worktree base: diverged local and remote hold rather than guess, creating nothing", async () => {
  const { store, repo, checkout, make, landUpstream } = await setup();
  try {
    landUpstream("theirs.txt");
    writeFileSync(join(checkout, "ours.txt"), "ours\n");
    sh(checkout, "add", "ours.txt");
    sh(checkout, "commit", "-q", "-m", "ours");
    const t = make();
    await assert.rejects(createWorktree(repo, t), (err: Error) => err instanceof PreparationHold && /have diverged/.test(err.message));
    assert.equal(existsSync(join(process.env.CRANE_HOME!, "worktrees", t.id)), false);
  } finally { store.close(); }
});

test("worktree base: a failed fetch isn't a hold on its own, but a commit it would've brought is", async () => {
  const { store, repo, checkout, make, landUpstream, origin } = await setup();
  try {
    const landed = landUpstream("landed.txt");
    sh(checkout, "remote", "set-url", "origin", `${origin}-gone`);

    const notes: string[] = [];
    const wt = await createWorktree(repo, make(), { note: (m) => notes.push(m) });
    assert.equal(wt.base, sh(checkout, "rev-parse", "main"));
    assert.ok(notes.some((m) => m.startsWith("Couldn't fetch main from origin")), notes.join("\n"));

    await assert.rejects(
      createWorktree(repo, make(), { required: [{ id: "t-x", title: "X", commit: landed }] }),
      (err: Error) => err instanceof PreparationHold && err.message.includes("t-x"),
    );
  } finally { store.close(); }
});

test("worktree base: a reused worktree is checked and never reset", async () => {
  const { store, repo, checkout, make, landUpstream } = await setup();
  try {
    const t = make();
    const wt = await createWorktree(repo, t);
    writeFileSync(join(wt.path, "committed.txt"), "work\n");
    sh(wt.path, "add", "committed.txt");
    sh(wt.path, "commit", "-q", "-m", "work so far");
    writeFileSync(join(wt.path, "uncommitted.txt"), "more work\n");
    const head = sh(wt.path, "rev-parse", "HEAD");
    const start = sh(checkout, "rev-parse", "main");

    // What it already contains passes, and comes back as it was.
    const again = await createWorktree(repo, t, { required: [{ id: "t-old", title: "Old", commit: start }] });
    assert.equal(again.path, wt.path);

    // What landed since it started doesn't.
    const landed = landUpstream("landed.txt");
    await assert.rejects(
      createWorktree(repo, t, { required: [{ id: "t-new", title: "New", commit: landed }] }),
      (err: Error) => err instanceof PreparationHold && err.message.includes("t-new") && err.message.includes("worktree"),
    );
    assert.equal(sh(wt.path, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(wt.path, "uncommitted.txt"), "utf8"), "more work\n");
  } finally { store.close(); }
});

test("prerequisite check: the factory starts from upstream when local main is behind, and the agent gets the commit", async () => {
  const { store, checkout, make, landUpstream, landedTask } = await setup();
  writeFileSync(join(checkout, "README.md"), "operator's edit\n");
  const landed = landUpstream("landed.txt");
  const before = sh(checkout, "rev-parse", "main");
  const t = make({ prerequisites: [landedTask(landed).id] });
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => store.getTask(t.id)!.status === "needs_review", "the task to finish");
    const { branch } = store.getTask(t.id)!;
    assert.ok(contains(checkout, landed, branch!), "its branch contains the prerequisite");
    assert.equal(sh(checkout, "rev-parse", "main"), before);
    assert.ok(!store.getTask(t.id)!.report!.changedFiles.includes("landed.txt"), "the prerequisite isn't reported as this task's change");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("prerequisite check: a commit missing from every base holds before dependencies or the agent, and a waiver lets it through", async () => {
  const { store, actions, checkout, make, landedTask } = await setup();
  // On a side branch only: recorded as landed, but on neither local main nor origin/main.
  sh(checkout, "checkout", "-q", "-b", "side");
  writeFileSync(join(checkout, "side.txt"), "side\n");
  sh(checkout, "add", "side.txt");
  sh(checkout, "commit", "-q", "-m", "side");
  const missing = sh(checkout, "rev-parse", "HEAD");
  sh(checkout, "checkout", "-q", "main");

  const prerequisite = landedTask(missing);
  const t = make({ prerequisites: [prerequisite.id] });
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => store.getTask(t.id)!.status === "failed", "the task to be held");
    const held = store.getTask(t.id)!;
    assert.equal(held.sessionId, null, "the agent never started");
    assert.equal(held.branch, null);
    assert.equal(held.worktree, null);
    assert.equal(sh(checkout, "branch", "--list", "crane/*"), "");
    const events = messages(store, t.id);
    assert.ok(events.some((m) => m.includes(prerequisite.id) && m.includes(missing.slice(0, 8)) && m.includes("retry this task")), events.join("\n"));
    assert.ok(events.includes("Held before the agent started"), events.join("\n"));
    assert.ok(!events.some((m) => /dependenc|Working on branch/i.test(m)), events.join("\n"));

    // A retry keeps the gate and holds again until the commit is there.
    const again = actions.retry(t.id);
    await until(() => store.getTask(again.id)!.status === "failed", "the retry to be held");

    const waived = make({ prerequisites: [prerequisite.id] });
    store.waivePrerequisites(waived.id);
    await until(() => store.getTask(waived.id)!.status === "needs_review", "the waived task to run");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("prerequisite check: a reused worktree without the commit holds, and its work goes to its branch", async () => {
  const { store, checkout, repo, make, landUpstream, landedTask } = await setup();
  const landed = landUpstream("landed.txt");
  sh(checkout, "fetch", "-q", "origin");
  const t = make({ prerequisites: [landedTask(landed).id] });
  // A worktree left by an earlier run, from before Crane checked its base.
  const branch = `crane/stale-${t.id.slice(2)}`;
  const path = join(process.env.CRANE_HOME!, "worktrees", t.id);
  sh(repo.path, "worktree", "add", "-q", "-b", branch, path, "main");
  writeFileSync(join(path, "progress.txt"), "half done\n");
  store.updateTask(t.id, { branch, worktree: path });

  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => store.getTask(t.id)!.status === "failed", "the task to be held");
    assert.equal(store.getTask(t.id)!.sessionId, null, "the agent never started");
    assert.ok(messages(store, t.id).some((m) => m.includes("worktree") && m.includes(landed.slice(0, 8))));
    await until(() => !existsSync(path), "the worktree to be put away");
    assert.equal(sh(checkout, "show", `${branch}:progress.txt`), "half done", "the work is saved, not reset");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("prerequisite check: an investigate-only task reads the operator's checkout, so that's what must contain it", async () => {
  const { store, make, checkout, landUpstream, landedTask } = await setup();
  const landed = landUpstream("landed.txt");
  sh(checkout, "fetch", "-q", "origin");
  const t = make({ prerequisites: [landedTask(landed).id] }, "observe");
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => store.getTask(t.id)!.status === "failed", "the task to be held");
    assert.ok(messages(store, t.id).some((m) => m.startsWith("Your checkout at") && m.includes("Update it")), messages(store, t.id).join("\n"));
    assert.equal(store.getTask(t.id)!.sessionId, null);
  } finally {
    await factory.stop();
    store.close();
  }
});

test("prerequisite commits: the merge commit, else where main landed, and nothing asked of the rest", async () => {
  const { store, repo, actions, make, landedTask } = await setup();
  try {
    const merged = landedTask("aaa");
    const alreadyThere = landedTask(null, "bbb");
    const legacy = landedTask(null);
    const noBranch = make();
    store.setStatus(noBranch.id, "done", "Done");
    const elsewhere = await actions.connectRepo(mkdtempInit(), "elsewhere");
    assert.notEqual(elsewhere.id, repo.id);
    const otherRepo = actions.createTask({ kind: "maintenance", title: "Elsewhere", brief: "", repoId: elsewhere.id, autonomy: "propose" });
    store.setStatus(otherRepo.id, "merged", "Merged", { merge: { commit: "ccc" } });

    const task = { prerequisites: [merged.id, alreadyThere.id, legacy.id, noBranch.id, otherRepo.id], prerequisitesWaivedAt: null, repoId: repo.id };
    const { commits, unrecorded } = store.prerequisiteCommits(task);
    assert.deepEqual(commits.map((c) => c.commit), ["aaa", "bbb"]);
    assert.deepEqual(unrecorded, [legacy.id]);
    assert.deepEqual(store.prerequisiteCommits({ ...task, prerequisitesWaivedAt: "2026-01-01" }), { commits: [], unrecorded: [] });
  } finally { store.close(); }
});

function mkdtempInit(): string {
  const dir = mkdtempSync(join(tmpdir(), "crane-base-other-"));
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "other\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-q", "-m", "start");
  return dir;
}
