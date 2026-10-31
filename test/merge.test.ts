import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landTask, MergeError } from "../src/factory/merge.js";
import { keepBothSides } from "../src/agents/simulated.js";
import type { Repo, Task } from "../src/core/types.js";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commitFile(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", msg);
}

/**
 * A bare `origin`, the operator's clone of it with main checked out, and a
 * task branch with one commit, like Crane leaves after an agent has worked.
 */
function setup(opts: { remote?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crane-merge-"));
  const checkout = join(root, "checkout");
  if (opts.remote === false) {
    sh(root, "init", "-q", "-b", "main", checkout);
  } else {
    sh(root, "init", "-q", "--bare", "-b", "main", join(root, "origin.git"));
    sh(root, "clone", "-q", join(root, "origin.git"), checkout);
    sh(checkout, "checkout", "-q", "-b", "main");
  }
  commitFile(checkout, "notes.md", "# Notes\n\nfirst\n", "start");
  if (opts.remote !== false) sh(checkout, "push", "-q", "-u", "origin", "main");
  sh(checkout, "branch", "crane/add-line-t1");

  const repo: Repo = { id: "r-x", name: "x", path: checkout, defaultBranch: "main", isFactory: false, addedAt: "" };
  const task: Task = {
    id: "t-1",
    kind: "maintenance",
    title: "Add a line",
    brief: "Add a line",
    repoId: repo.id,
    autonomy: "propose",
    status: "merging",
    agentId: null,
    branch: "crane/add-line-t1",
    worktree: join(root, "wt"),
    sessionId: null,
    report: null,
    costUsd: 0,
    createdAt: "",
    startedAt: null,
    finishedAt: null,
  };
  sh(checkout, "worktree", "add", "-q", task.worktree!, task.branch!);
  return { root, checkout, repo, task, wt: task.worktree! };
}

/** Someone else lands work on origin's main after the task branched off. */
function landElsewhere(root: string, file: string, text: string) {
  const other = join(root, "other");
  sh(root, "clone", "-q", join(root, "origin.git"), other);
  commitFile(other, file, text, `elsewhere: ${file}`);
  sh(other, "push", "-q", "origin", "main");
}

const events: string[] = [];
const emit = (_t: string, m: string) => void events.push(m);
const noResolve = async () => {
  throw new Error("should not be asked to resolve conflicts");
};

test("merge: lands the branch on origin and the clean checkout with one merge commit", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  landElsewhere(root, "other.txt", "other\n");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });

  assert.equal(r.pushedTo, "origin");
  assert.equal(r.checkoutBehind, null);
  assert.ok(r.commit);
  const originMain = sh(join(root, "origin.git"), "rev-parse", "main");
  assert.equal(originMain, r.commit);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), r.commit, "operator's checkout was fast-forwarded");
  assert.match(sh(checkout, "log", "-1", "--format=%s"), /^Merge branch 'crane\/add-line-t1'/);
  assert.equal(sh(checkout, "rev-list", "--parents", "-n1", "HEAD").split(" ").length, 3, "a real merge commit");
  assert.equal(readFileSync(join(checkout, "feature.txt"), "utf8"), "feature\n");
  assert.equal(readFileSync(join(checkout, "other.txt"), "utf8"), "other\n");
});

test("merge: conflicts go to the resolver and the resolution lands", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");

  let asked: string[] = [];
  const r = await landTask({
    repo,
    task,
    workdir: wt,
    emit,
    resolveConflicts: async ({ cwd, files, base }) => {
      asked = files;
      assert.equal(base, "origin/main");
      for (const f of files) writeFileSync(join(cwd, f), keepBothSides(readFileSync(join(cwd, f), "utf8")));
    },
  });

  assert.deepEqual(asked, ["notes.md"]);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), r.commit);
  const merged = readFileSync(join(checkout, "notes.md"), "utf8");
  assert.match(merged, /from main/);
  assert.match(merged, /from the task/);
  assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
});

test("merge: unresolved conflicts stop before anything is pushed", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");
  const before = sh(join(root, "origin.git"), "rev-parse", "main");
  const branchBefore = sh(checkout, "rev-parse", task.branch!);

  await assert.rejects(
    landTask({ repo, task, workdir: wt, emit, resolveConflicts: async () => {} }),
    (err: Error) => err instanceof MergeError && /unresolved in notes\.md/.test(err.message),
  );
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before, "origin untouched");
  assert.equal(sh(checkout, "rev-parse", task.branch!), branchBefore, "task branch untouched");
  assert.equal(sh(wt, "status", "--porcelain", "--untracked-files=no"), "", "merge was aborted");
});

test("merge: a checkout with local changes is left alone", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  writeFileSync(join(checkout, "notes.md"), "operator is mid-edit\n");
  const localBefore = sh(checkout, "rev-parse", "main");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });

  assert.equal(r.checkoutBehind, checkout);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), r.commit, "still pushed");
  assert.equal(sh(checkout, "rev-parse", "main"), localBefore, "local main not moved");
  assert.equal(readFileSync(join(checkout, "notes.md"), "utf8"), "operator is mid-edit\n", "operator's edit intact");
});

test("merge: without a remote, moves local main when it isn't checked out", async () => {
  const { checkout, repo, task, wt } = setup({ remote: false });
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  sh(checkout, "checkout", "-q", "-b", "operator-work");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });

  assert.equal(r.pushedTo, null);
  assert.equal(r.checkoutBehind, null);
  assert.equal(sh(checkout, "rev-parse", "main"), r.commit);
  assert.equal(sh(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "operator-work", "operator's branch untouched");
});

test("merge: running it again after it landed is a no-op", async () => {
  const { root, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  const first = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });
  const again = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });
  assert.equal(again.commit, null);
  assert.equal(again.head, first.commit);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), first.commit);
});

test("merge: keepBothSides drops markers and the diff3 base", () => {
  const text = "a\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> branch\nz\n";
  assert.equal(keepBothSides(text), "a\nours\ntheirs\nz\n");
});

test("merge: if origin moves mid-merge, it starts over instead of forcing", async () => {
  const { root, repo, task, wt } = setup();
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");

  let calls = 0;
  const r = await landTask({
    repo,
    task,
    workdir: wt,
    emit,
    resolveConflicts: async ({ cwd, files }) => {
      calls++;
      // While the agent works, someone else pushes. The first push must be refused.
      if (calls === 1) {
        const late = join(root, "late");
        sh(root, "clone", "-q", join(root, "origin.git"), late);
        commitFile(late, "late.txt", "late\n", "late push");
        sh(late, "push", "-q", "origin", "main");
      }
      for (const f of files) writeFileSync(join(cwd, f), keepBothSides(readFileSync(join(cwd, f), "utf8")));
    },
  });

  assert.equal(calls, 2, "resolved again on top of the new tip");
  const origin = join(root, "origin.git");
  assert.equal(sh(origin, "rev-parse", "main"), r.commit);
  assert.equal(sh(origin, "show", "main:late.txt"), "late", "the late push survived");
});

test("factory: a task goes from work to review to merged and pushed, through a conflict", async () => {
  process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));
  const { Store } = await import("../src/core/store.js");
  const { OperatorActions } = await import("../src/factory/actions.js");
  const { Factory } = await import("../src/factory/orchestrator.js");
  const { SimulatedDriver } = await import("../src/agents/simulated.js");

  const root = mkdtempSync(join(tmpdir(), "crane-e2e-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commitFile(checkout, "README.md", "hi\n", "start");
  sh(checkout, "push", "-q", "-u", "origin", "main");

  const store = new Store();
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "e2e");
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 20 });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), `timed out waiting for ${what}`);
  };

  const t = actions.createTask({ kind: "maintenance", title: "Add a greeting", brief: "", repoId: repo.id, autonomy: "propose" });
  factory.start();
  try {
    await until(() => store.getTask(t.id)?.status === "needs_review", "review");
    // While it waits for review, someone lands a clashing file on origin.
    const other = join(root, "other");
    sh(root, "clone", "-q", origin, other);
    sh(other, "checkout", "-q", "main");
    execFileSync("mkdir", ["-p", join(other, ".crane-simulated")]);
    commitFile(other, `.crane-simulated/${t.id}.md`, "someone else's take\n", "clash");
    sh(other, "push", "-q", "origin", "main");

    await actions.approve(t.id);
    await until(() => !["merging"].includes(store.getTask(t.id)!.status), "merge");
    const done = store.getTask(t.id)!;
    const events = store.listEvents(t.id);
    assert.equal(done.status, "merged", events.map((e) => e.message).join("\n"));
    assert.ok(events.some((e) => /conflict with origin\/main/.test(e.message)), "the conflict went to an agent");
    assert.equal(done.worktree, null, "Crane's worktree is cleaned up");
    // The outcome is recorded before cleanup, so wait for the agent to finish tidying.
    await until(() => store.listAgents()[0]?.state === "idle", "cleanup");

    const landed = sh(origin, "show", `main:.crane-simulated/${t.id}.md`);
    assert.match(landed, /someone else's take/);
    assert.match(landed, /Add a greeting/);
    assert.equal(sh(checkout, "rev-parse", "HEAD"), sh(origin, "rev-parse", "main"), "operator's clean checkout caught up");
    assert.equal(sh(checkout, "branch", "--list", done.branch!), "", "merged branch deleted");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("actions: approve merges by default, approve only keeps the branch, merge picks it up later", async () => {
  const { Store } = await import("../src/core/store.js");
  const { OperatorActions } = await import("../src/factory/actions.js");
  const { lastMergeOutcome } = await import("../src/core/types.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "crane-")), "t.db"));
  const actions = new OperatorActions(store);
  const r = store.addRepo({ path: mkdtempSync(join(tmpdir(), "crane-repo-")) });
  const make = (title: string) => {
    const t = store.createTask({ kind: "maintenance", title, brief: "", repoId: r.id, autonomy: "propose" });
    store.updateTask(t.id, { branch: `crane/${t.id}`, agentId: "a-jib" });
    store.setStatus(t.id, "needs_review");
    return t;
  };

  const a = make("merge me");
  assert.equal((await actions.approve(a.id)).status, "merging");
  assert.equal(store.getTask(a.id)?.agentId, null, "free for any agent to claim");

  const b = make("keep me");
  assert.equal((await actions.approve(b.id, undefined, { merge: false })).status, "approved");
  assert.equal(store.getTask(b.id)?.branch, `crane/${b.id}`);

  // One merge per repo at a time.
  assert.equal(store.claimNextMerge("a-boom", [r.id]), null);
  assert.equal(store.claimNextMerge("a-boom")?.id, a.id);
  assert.equal(store.claimNextMerge("a-hoist"), null, "claimed once");

  assert.equal((await actions.merge(b.id)).status, "merging");
  await assert.rejects(actions.merge(a.id), /isn't ready to merge/);

  // A failed merge comes back to the operator with the reason.
  store.setStatus(a.id, "needs_review", "Couldn't merge", { merge: { error: "boom" } });
  assert.equal(lastMergeOutcome(store.listEvents(a.id))?.error, "boom");
  assert.equal(store.overview({ running: false, paused: false, driver: "x" }).counts.merging, 1);
  store.close();
});
