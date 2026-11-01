import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landTask as land, MergeError, type MergeRequest } from "../src/factory/merge.js";
const landTask = (req: MergeRequest) => land({ checks: ["true"], ...req });
import { keepBothSides } from "../src/agents/simulated.js";
import { installDependencies } from "../src/factory/deps.js";
import type { Repo, Task } from "@crane/contracts";

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
    driver: null,
    model: null,
    effort: null,
    driverSettings: null,
    assignee: null,
    preApprovedAt: null,
    prerequisites: [],
    prerequisitesWaivedAt: null,
    acceptance: [],
    lookouts: [],
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

test("merge: failed and unconfigured checks never push", async () => {
  for (const checks of [["echo broken; exit 1"], []]) {
    const { root, repo, task, wt } = setup();
    commitFile(wt, "feature.txt", "feature\n", "feature");
    const before = sh(join(root, "origin.git"), "rev-parse", "main");
    const evidence: import("@crane/contracts").ValidationRun[] = [];
    await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
      checks, recordValidation: r => evidence.push(r) }), /checks did not pass/);
    assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
    assert.equal(evidence[0]!.status, checks.length ? "failed" : "unconfigured");
    assert.equal(evidence[0]!.commit, sh(wt, "rev-parse", "HEAD"));
    if (checks.length) assert.match(evidence[0]!.logs, /broken/);
  }
});

test("merge: blocked execution and checks that edit the candidate never push", async () => {
  for (const checks of [["exit 126"], ["echo changed >> notes.md"]]) {
    const { root, repo, task, wt } = setup();
    commitFile(wt, "feature.txt", "feature\n", "feature");
    const before = sh(join(root, "origin.git"), "rev-parse", "main");
    const evidence: import("@crane/contracts").ValidationRun[] = [];
    await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
      checks, recordValidation: r => evidence.push(r) }), /checks did not pass/);
    assert.equal(evidence.at(-1)!.status, "blocked");
    assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
  }
});

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

test("merge: a newly introduced workspace is available to conflict agents and merge checks", async () => {
  for (const conflict of [false, true]) {
    const { checkout, repo, task, wt } = setup({ remote: false });
    commitFile(checkout, ".gitignore", "node_modules/\n", "ignore dependencies");
    const manifest = { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/*"] };
    const packages: Record<string, unknown> = { "": manifest };
    commitFile(checkout, "package.json", JSON.stringify(manifest), "manifest");
    commitFile(checkout, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }), "lock");
    sh(wt, "merge", "--ff-only", "main");
    await installDependencies(wt);

    // Main adds a workspace after the task's environment was prepared.
    mkdirSync(join(checkout, "packages/contracts"), { recursive: true });
    commitFile(checkout, "packages/contracts/package.json", JSON.stringify({ name: "@fixture/contracts", version: "1.0.0" }), "workspace");
    packages["packages/contracts"] = { name: "@fixture/contracts", version: "1.0.0" };
    packages["node_modules/@fixture/contracts"] = { link: true, resolved: "packages/contracts" };
    commitFile(checkout, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }), "workspace lock");
    commitFile(wt, "notes.md", "from the task\n", "task edit");
    if (conflict) commitFile(checkout, "notes.md", "from main\n", "main edit");

    let resolved = false;
    const result = await landTask({
      repo, task, workdir: wt, emit,
      checks: ["test -f node_modules/@fixture/contracts/package.json"],
      resolveConflicts: async ({ cwd, files }) => {
        resolved = true;
        assert.equal(JSON.parse(readFileSync(join(cwd, "node_modules/@fixture/contracts/package.json"), "utf8")).name, "@fixture/contracts");
        for (const file of files) writeFileSync(join(cwd, file), keepBothSides(readFileSync(join(cwd, file), "utf8")));
        // Conflict resolution can damage a link; preparation must run again before checks.
        const { rmSync } = await import("node:fs");
        rmSync(join(cwd, "node_modules/@fixture/contracts"));
      },
    });
    assert.equal(resolved, conflict);
    assert.ok(result.commit, "the merge landed after its workspace check passed");
  }
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

test("merge: diverged local and origin main stop before anything is pushed or moved", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  commitFile(checkout, "local.txt", "local\n", "only on local main");
  landElsewhere(root, "other.txt", "other\n");
  const originBefore = sh(join(root, "origin.git"), "rev-parse", "main");
  const localBefore = sh(checkout, "rev-parse", "main");
  const branchBefore = sh(checkout, "rev-parse", task.branch!);

  await assert.rejects(
    landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve }),
    (err: Error) => err instanceof MergeError && /have diverged/.test(err.message),
  );
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), originBefore, "origin untouched, never forced");
  assert.equal(sh(checkout, "rev-parse", "main"), localBefore, "local main untouched");
  assert.equal(sh(checkout, "rev-parse", task.branch!), branchBefore, "task branch untouched");
});

test("merge: local commits not on origin yet are pushed along with the task, and the operator is told", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  commitFile(checkout, "local.txt", "local\n", "only on local main");
  const notes: string[] = [];

  const r = await landTask({ repo, task, workdir: wt, emit: (_t, m) => void notes.push(m), resolveConflicts: noResolve });

  assert.ok(notes.includes("Your local main has 1 commit not on origin yet. They'll be pushed too."), notes.join("\n"));
  const origin = join(root, "origin.git");
  assert.equal(sh(origin, "rev-parse", "main"), r.commit);
  assert.equal(sh(origin, "show", "main:local.txt"), "local");
  assert.equal(sh(origin, "show", "main:feature.txt"), "feature");
  assert.equal(sh(checkout, "rev-parse", "HEAD"), r.commit);
});

test("merge: a resolver that fails aborts the merge and pushes nothing", async () => {
  const { root, checkout, repo, task, wt } = setup();
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");
  const before = sh(join(root, "origin.git"), "rev-parse", "main");
  const localBefore = sh(checkout, "rev-parse", "main");

  await assert.rejects(
    landTask({ repo, task, workdir: wt, emit, resolveConflicts: async () => { throw new Error("agent gave up"); } }),
    /agent gave up/,
  );
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before, "origin untouched");
  assert.equal(sh(checkout, "rev-parse", "main"), localBefore, "local main untouched");
  assert.equal(sh(wt, "status", "--porcelain", "--untracked-files=no"), "", "merge was aborted");
  assert.throws(() => sh(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "no merge left in progress");
});

test("merge: uncommitted changes in Crane's worktree are never merged", async () => {
  const { root, repo, task, wt } = setup();
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  writeFileSync(join(wt, "notes.md"), "not committed\n");
  const before = sh(join(root, "origin.git"), "rev-parse", "main");

  await assert.rejects(
    landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve }),
    (err: Error) => err instanceof MergeError && /uncommitted changes/.test(err.message),
  );
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
  assert.equal(readFileSync(join(wt, "notes.md"), "utf8"), "not committed\n", "the work is still there");
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
  const checked: string[] = [];
  const r = await landTask({
    repo,
    task,
    workdir: wt,
    emit,
    recordValidation: run => checked.push(run.commit),
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
  assert.equal(checked.length, 2, "checks ran after each conflict resolution and remote-moved retry");
  assert.notEqual(checked[0], checked[1]);
  assert.equal(checked[1], r.head);
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
  store.setRepoChecks(repo.id, ["true"]);
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
    mkdirSync(join(other, ".crane-simulated"), { recursive: true });
    commitFile(other, `.crane-simulated/${t.id}.md`, "someone else's take\n", "clash");
    sh(other, "push", "-q", "origin", "main");

    await actions.approve(t.id);
    await until(() => !["merging"].includes(store.getTask(t.id)!.status), "merge");
    const done = store.getTask(t.id)!;
    assert.deepEqual(done.report?.validation?.map(r => [r.phase, r.status]), [["review", "passed"], ["merge", "passed"]]);
    assert.equal(done.report?.validation?.at(-1)?.commit, sh(origin, "rev-parse", "main"));
    const events = store.listEvents(t.id);
    assert.equal(done.status, "merged", events.map((e) => e.message).join("\n"));
    assert.ok(events.some((e) => /conflict with origin\/main/.test(e.message)), "the conflict went to an agent");
    assert.equal(done.worktree, null, "Crane's worktree is cleaned up");
    // The outcome is recorded before cleanup, so wait for the agent to finish tidying.
    // Every member: the list is sorted by name, so the one merging isn't necessarily first.
    await until(() => store.listAgents().every((a) => a.state === "idle"), "cleanup");

    const landed = sh(origin, "show", `main:.crane-simulated/${t.id}.md`);
    assert.match(landed, /someone else's take/);
    assert.match(landed, /Add a greeting/);
    assert.equal(sh(checkout, "rev-parse", "HEAD"), sh(origin, "rev-parse", "main"), "operator's clean checkout caught up");
    assert.equal(sh(checkout, "branch", "--list", done.branch!), "", "merged branch deleted");
    const reviewId = events.find((e) => e.data?.postmortemTaskId)?.data?.postmortemTaskId as string;
    assert.ok(reviewId, "successful merge queues a post-mortem");
    await until(() => ["done", "needs_review"].includes(store.getTask(reviewId)!.status), "post-mortem report");
    const review = store.getTask(reviewId)!;
    assert.equal(review.autonomy, "observe");
    assert.equal(review.branch, null);
    assert.equal(review.worktree, null);
    assert.ok(review.report, "post-mortem uses the normal task report flow");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("factory: a pre-approved task skips review and lands once its checks pass", async () => {
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
  store.setRepoChecks(repo.id, ["true"]);
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 20 });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), `timed out waiting for ${what}`);
  };

  const start = sh(origin, "rev-parse", "main");
  // A failing check fails the task as usual: pre-approval never skips the gate.
  store.setRepoChecks(repo.id, ["false"]);
  const failing = actions.createTask({ kind: "maintenance", title: "Fails its checks", brief: "", repoId: repo.id, autonomy: "propose" });
  actions.preApprove(failing.id);
  factory.start();
  try {
    await until(() => store.getTask(failing.id)?.status === "failed", "the failing task");
    assert.equal(sh(origin, "rev-parse", "main"), start, "nothing pushed");

    store.setRepoChecks(repo.id, ["true"]);
    const t = actions.createTask({ kind: "maintenance", title: "Add a greeting", brief: "", repoId: repo.id, autonomy: "propose" });
    actions.preApprove(t.id, "Trusted change");
    await until(() => store.getTask(t.id)?.status === "merged", "pre-approved merge");
    const events = store.listEvents(t.id);
    const statuses = events.filter((e) => e.type === "status").map((e) => e.data?.status);
    assert.ok(!statuses.includes("needs_review"), `never waited for review: ${statuses.join(", ")}`);
    assert.ok(events.some((e) => e.type === "operator" && e.message === "Pre-approved: Trusted change"));
    const done = store.getTask(t.id)!;
    assert.deepEqual(done.report?.validation?.map(r => [r.phase, r.status]), [["review", "passed"], ["merge", "passed"]]);
    assert.match(sh(origin, "show", `main:.crane-simulated/${t.id}.md`), /Add a greeting/);
    await until(() => store.listAgents().every((a) => a.state === "idle"), "cleanup");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("actions: approve merges by default, approve only keeps the branch, merge picks it up later", async () => {
  const { Store } = await import("../src/core/store.js");
  const { OperatorActions } = await import("../src/factory/actions.js");
  const { lastMergeOutcome } = await import("@crane/contracts");
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
  assert.equal(store.overview({ running: false, paused: false, driver: "x", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null }).counts.merging, 1);
  store.close();
});
