import "../src/application.js";
import { test, type TestContext } from "node:test";
import { temporaryRoot, onFixtureCleanup, testHome } from "./support/fixtures.js";
import assert from "node:assert/strict";
import { sh } from "./support/git.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dependencyInputs, landTask as land, MergeError, type MergeRequest } from "../packages/factory/src/merge.js";
const landTask = (req: MergeRequest) => land({ checks: ["true"], ...req });
import { keepBothSides } from "../packages/agent-drivers/src/simulated.js";
import { installDependencies } from "@crane/worktree-deps";
import type { Repo, Task } from "@crane/contracts";
import type { RunContext } from "@crane/agent-protocol";

function commitFile(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", msg);
}

/**
 * A bare `origin`, the operator's clone of it with main checked out, and a
 * task branch with one commit, like Crane leaves after an agent has worked.
 */
function setup(ctx: TestContext, opts: { remote?: boolean } = {}) {
  const root = temporaryRoot(ctx, "crane-merge-");
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
    postmortemOf: null,
    preApprovedAt: null,
    prerequisites: [],
    prerequisitesWaivedAt: null,
    acceptance: [],
    acceptanceChecks: [],
    lookouts: [],
    report: null,
    costUsd: 0,
    createdAt: "",
    createdBy: null,
    scheduledAt: null,
    scheduleId: null,
    followUpOf: null,
    followUpFinding: null,
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

test("merge: visual gate rejects the candidate before dependencies and checks", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
  commitFile(wt, "package.json", '{"name":"fixture","version":"1.0.0"}\n', "manifest");
  commitFile(wt, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n', "lock");
  const before = sh(join(root, "origin.git"), "rev-parse", "main");
  const branchCommit = sh(wt, "rev-parse", "HEAD");
  const notes: string[] = [];
  let checked = false;
  let gated = false;
  await assert.rejects(landTask({ repo, task, workdir: wt,
    emit: (_type, message) => { notes.push(message); }, resolveConflicts: noResolve,
    recordValidation: () => { checked = true; },
    verifyVisualReview: async (commit, tree, branch, changedFiles) => {
      gated = true;
      assert.equal(checked, false);
      assert.deepEqual(notes, [], "dependency preparation has not started");
      assert.equal(commit, sh(wt, "rev-parse", "HEAD"));
      assert.equal(tree, sh(wt, "rev-parse", "HEAD^{tree}"));
      assert.equal(branch, branchCommit);
      assert.deepEqual(changedFiles, ["package-lock.json", "package.json"]);
      throw new Error("Candidate visual inspection required");
    },
  }), /visual inspection required/);
  assert.equal(gated, true);
  assert.equal(checked, false);
  assert.ok(!existsSync(join(wt, "node_modules")));
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), before);
});

test("merge: visual gate rechecks authorization after checks and prevents push and local default update", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
  commitFile(wt, "feature.txt", "feature\n", "feature");
  const before = sh(join(root, "origin.git"), "rev-parse", "main");
  const branchCommit = sh(wt, "rev-parse", "HEAD");
  let checked = false;
  let gates = 0;
  await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
    recordValidation: () => { checked = true; },
    verifyVisualReview: async (commit, tree, branch, changedFiles) => {
      gates++;
      assert.equal(checked, gates === 2, "visual decision is checked before and after configured checks");
      assert.equal(commit, sh(wt, "rev-parse", "HEAD"));
      assert.equal(tree, sh(wt, "rev-parse", "HEAD^{tree}"));
      assert.equal(branch, branchCommit);
      assert.deepEqual(changedFiles, ["feature.txt"]);
      if (gates === 2) throw new Error("Candidate visual inspection required");
    },
  }), /visual inspection required/);
  assert.equal(gates, 2);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), before);
});

test("merge: failed and unconfigured checks never push", async (ctx) => {
  for (const checks of [["echo broken; exit 1"], []]) {
    const { root, repo, task, wt } = setup(ctx);
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

test("merge: blocked execution and checks that edit the candidate never push", async (ctx) => {
  for (const checks of [["exit 126"], ["echo changed >> notes.md"]]) {
    const { root, repo, task, wt } = setup(ctx);
    commitFile(wt, "feature.txt", "feature\n", "feature");
    const before = sh(join(root, "origin.git"), "rev-parse", "main");
    const evidence: import("@crane/contracts").ValidationRun[] = [];
    await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
      checks, recordValidation: r => evidence.push(r) }), /checks did not pass/);
    assert.equal(evidence.at(-1)!.status, "blocked");
    assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), before);
  }
});

test("merge: lands the branch on origin and the clean checkout with one merge commit", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: dependency changes leave a shared task note to install in the operator's checkout", async (ctx) => {
  for (const file of ["package.json", "package-lock.json", "packages/new/package.json", "packages/new/package-lock.json", "notes.md"]) {
    for (const dirty of [false, true]) {
      const { checkout, repo, task, wt } = setup(ctx, { remote: false });
      mkdirSync(dirname(join(wt, file)), { recursive: true });
      commitFile(wt, file, "{}\n", "task change");
      if (dirty) writeFileSync(join(checkout, "notes.md"), "operator's edit\n");
      const notes: { type: string; message: string; data?: Record<string, unknown> }[] = [];
      const result = await landTask({ repo, task, workdir: wt,
        emit: (type, message, data) => { notes.push({ type, message, data }); }, resolveConflicts: noResolve });
      const reminders = notes.filter(note => /run npm install/.test(note.message));
      if (file === "notes.md") {
        assert.deepEqual(reminders, [], "ordinary source changes need no install notice");
      } else {
        assert.equal(reminders.length, 1);
        assert.equal(reminders[0]!.type, "note", "CLI and web read the same task notes");
        assert.ok(reminders[0]!.message.includes(checkout));
        assert.ok(reminders[0]!.message.includes(file));
        assert.deepEqual(reminders[0]!.data, { dependencyFiles: [file] });
      }
      assert.equal(result.checkoutBehind, dirty ? checkout : null);
      assert.ok(!existsSync(join(checkout, "node_modules")), "Crane never installs in the operator's checkout");
      if (dirty) assert.equal(readFileSync(join(checkout, "notes.md"), "utf8"), "operator's edit\n");
    }
  }
});

test("merge: conflicts go to the resolver and the resolution lands", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: interrupted resolver validation recovers committed edits and retains landing gates", async (ctx) => {
  const { checkout, repo, task, wt } = setup(ctx, { remote: false });
  commitFile(wt, "notes.md", "task\n", "task edit");
  commitFile(checkout, "notes.md", "main\n", "main edit");
  const before = sh(checkout, "rev-parse", "HEAD");
  const ac = new AbortController();
  let checkpoint = "";
  await assert.rejects(landTask({ repo, task, workdir: wt, emit, signal: ac.signal,
    resolveConflicts: async ({ cwd }) => {
      writeFileSync(join(cwd, "notes.md"), "saved resolution\n");
      return { visualReviewRequired: true };
    },
    validateResolution: async (ctx) => {
      checkpoint = ctx.checkpoint;
      assert.equal(ctx.visualReviewRequired, true);
      assert.equal(sh(wt, "status", "--porcelain"), "");
      ac.abort();
      throw new Error("factory interrupted during typecheck");
    },
  }), /factory interrupted/);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), before);
  assert.equal(sh(wt, "rev-parse", "HEAD"), checkpoint);
  let validations = 0;
  let gates = 0;
  const recovered = { repo, task, workdir: wt, emit, resolveConflicts: noResolve,
    validateResolution: async (ctx: { checkpoint: string; visualReviewRequired: boolean }) => {
      validations++;
      assert.equal(ctx.checkpoint, checkpoint);
      assert.equal(ctx.visualReviewRequired, true, "editing phase classification survives interruption");
      assert.equal(readFileSync(join(wt, "notes.md"), "utf8"), "saved resolution\n");
    },
  };
  await assert.rejects(landTask({ ...recovered, verifyVisualReview: async () => {
    throw new Error("visual decision required");
  } }), /visual decision required/);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), before);
  const result = await landTask({ ...recovered,
    verifyVisualReview: async () => { gates++; },
    recordValidation: () => { validations++; },
  });
  assert.equal(result.commit, checkpoint);
  assert.equal(gates, 2, "approval gates still run before checks and landing");
  assert.equal(validations, 3, "both resolver validations and the external merge check run");
});

for (const changed of ["base", "task", "workspace"] as const) {
  test(`merge: resolution checkpoint cannot bypass changed ${changed}`, async (ctx) => {
    const { checkout, repo, task, wt } = setup(ctx, { remote: false });
    commitFile(wt, "notes.md", "task\n", "task edit");
    commitFile(checkout, "notes.md", "main\n", "main edit");
    await assert.rejects(landTask({ repo, task, workdir: wt, emit,
      resolveConflicts: async ({ cwd }) => { writeFileSync(join(cwd, "notes.md"), "saved\n"); },
      validateResolution: async () => { throw new Error("interrupted"); },
    }), /interrupted/);
    if (changed === "workspace") {
      writeFileSync(join(wt, "notes.md"), "unexpected edits\n");
      await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
        validateResolution: async () => { assert.fail("dirty workspace must not be offered"); },
      }), /uncommitted changes/);
      assert.equal(readFileSync(join(wt, "notes.md"), "utf8"), "unexpected edits\n");
      return;
    }
    if (changed === "base") commitFile(checkout, "other.md", "new base\n", "advance main");
    else {
      sh(checkout, "worktree", "add", "-q", join(checkout, "task-update"), task.branch!);
      commitFile(join(checkout, "task-update"), "other.md", "new task\n", "advance task");
    }
    let resolved = 0;
    await landTask({ repo, task, workdir: wt, emit,
      resolveConflicts: async ({ cwd }) => { resolved++; writeFileSync(join(cwd, "notes.md"), "fresh\n"); },
      validateResolution: async () => { assert.equal(readFileSync(join(wt, "notes.md"), "utf8"), "fresh\n"); },
    });
    assert.equal(resolved, 1, "changed inputs require a fresh resolution");
  });
}

test("merge: a newly introduced workspace is available to conflict agents and merge checks", async (ctx) => {
  for (const conflict of [false, true]) {
    const { checkout, repo, task, wt } = setup(ctx, { remote: false });
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

test("merge: dependency inputs are manifests, lockfiles and package manager settings at any depth", () => {
  assert.deepEqual(
    dependencyInputs(["notes.md", "package.json", "packages/a/package.json", "package-lock.json", "web/yarn.lock", ".npmrc", "src/package.ts"]),
    ["package.json", "packages/a/package.json", "package-lock.json", "web/yarn.lock", ".npmrc"],
  );
});

test("merge: conflicted manifests defer dependency preparation until the resolution, and checks see the resolved install", async (ctx) => {
  const { checkout, repo, task, wt } = setup(ctx, { remote: false });
  commitFile(checkout, ".gitignore", "node_modules/\n", "ignore dependencies");
  const manifest = { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/*"] };
  const lock = (root: object, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": root, ...extra } });
  commitFile(checkout, "package.json", JSON.stringify(manifest), "manifest");
  commitFile(checkout, "package-lock.json", lock(manifest), "lock");
  sh(wt, "merge", "--ff-only", "main");
  await installDependencies(wt);

  // The task and main both change the manifest and lockfile; main also adds a workspace.
  const taskManifest = { ...manifest, description: "from the task" };
  commitFile(wt, "package.json", JSON.stringify(taskManifest), "task manifest");
  commitFile(wt, "package-lock.json", lock(taskManifest), "task lock");
  const workspace = { name: "@fixture/contracts", version: "1.0.0" };
  mkdirSync(join(checkout, "packages/contracts"), { recursive: true });
  commitFile(checkout, "packages/contracts/package.json", JSON.stringify(workspace), "workspace");
  const mainManifest = { ...manifest, license: "MIT" };
  const links = { "packages/contracts": workspace, "node_modules/@fixture/contracts": { link: true, resolved: "packages/contracts" } };
  commitFile(checkout, "package.json", JSON.stringify(mainManifest), "main manifest");
  commitFile(checkout, "package-lock.json", lock(mainManifest, links), "main lock");

  const notes: string[] = [];
  let asked: { files: string[]; deferred?: string[] } | null = null;
  const result = await landTask({
    repo, task, workdir: wt,
    emit: (_t, m) => void notes.push(m),
    checks: ["test -f node_modules/@fixture/contracts/package.json"],
    resolveConflicts: async ({ cwd, files, deferredDependencies }) => {
      asked = { files, deferred: deferredDependencies };
      assert.ok(!notes.some((n) => /Installing dependencies|Couldn't prepare/.test(n)), "no install was attempted from conflicted files");
      const resolved = { ...manifest, description: "from the task", license: "MIT" };
      writeFileSync(join(cwd, "package.json"), JSON.stringify(resolved));
      writeFileSync(join(cwd, "package-lock.json"), lock(resolved, links));
    },
  });

  assert.deepEqual(asked, { files: ["package-lock.json", "package.json"], deferred: ["package-lock.json", "package.json"] });
  const deferredAt = notes.findIndex((n) => /^Deferred dependency preparation: package-lock\.json, package\.json are conflicted/.test(n));
  const installedAt = notes.findIndex((n) => /^Installed dependencies \(npm ci/.test(n));
  assert.ok(deferredAt >= 0, "the operator is told preparation was deferred");
  assert.ok(installedAt > deferredAt, "Crane installed from the resolved files before merge checks");
  assert.ok(result.commit, "the merge landed after its workspace check passed");
});

test("merge: unresolved conflicts stop before anything is pushed", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: a checkout with local changes is left alone", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  writeFileSync(join(checkout, "notes.md"), "operator is mid-edit\n");
  const localBefore = sh(checkout, "rev-parse", "main");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });

  assert.equal(r.checkoutBehind, checkout);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), r.commit, "still pushed");
  assert.equal(sh(checkout, "rev-parse", "main"), localBefore, "local main not moved");
  assert.equal(readFileSync(join(checkout, "notes.md"), "utf8"), "operator is mid-edit\n", "operator's edit intact");
});

test("merge: without a remote, moves local main when it isn't checked out", async (ctx) => {
  const { checkout, repo, task, wt } = setup(ctx, { remote: false });
  commitFile(wt, "feature.txt", "feature\n", "add feature");
  sh(checkout, "checkout", "-q", "-b", "operator-work");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve });

  assert.equal(r.pushedTo, null);
  assert.equal(r.checkoutBehind, null);
  assert.equal(sh(checkout, "rev-parse", "main"), r.commit);
  assert.equal(sh(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "operator-work", "operator's branch untouched");
});

test("merge: diverged local and origin main stop before anything is pushed or moved", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: local commits not on origin yet are pushed along with the task, and the operator is told", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: a resolver that fails aborts the merge and pushes nothing", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
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

test("merge: uncommitted changes in Crane's worktree are never merged", async (ctx) => {
  const { root, repo, task, wt } = setup(ctx);
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

test("merge: running it again after it landed is a no-op", async (ctx) => {
  const { root, repo, task, wt } = setup(ctx);
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

test("merge: if origin moves mid-merge, it starts over instead of forcing", async (ctx) => {
  const { root, repo, task, wt } = setup(ctx);
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

test("merge: a remote-moved retry requires authorization before checking its changed candidate", async (ctx) => {
  const { root, checkout, repo, task, wt } = setup(ctx);
  commitFile(wt, "feature.txt", "feature\n", "feature");
  const before = sh(checkout, "rev-parse", "HEAD");
  const checked: string[] = [];
  let authorizedTree: string | undefined;
  let gates = 0;
  let remoteHead = before;
  await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve,
    recordValidation: run => { checked.push(run.commit); },
    verifyVisualReview: async (commit, tree) => {
      gates++;
      if (gates === 1) {
        authorizedTree = tree;
        assert.deepEqual(checked, []);
      } else if (gates === 2) {
        assert.equal(tree, authorizedTree);
        assert.deepEqual(checked, [commit]);
        landElsewhere(root, "late.txt", "late\n");
        remoteHead = sh(join(root, "origin.git"), "rev-parse", "main");
      } else {
        assert.notEqual(tree, authorizedTree);
        assert.equal(checked.length, 1, "the changed retry has not run checks");
        throw new Error("Changed candidate requires visual inspection");
      }
    },
  }), /Changed candidate requires visual inspection/);
  assert.equal(gates, 3);
  assert.equal(checked.length, 1);
  assert.equal(sh(join(root, "origin.git"), "rev-parse", "main"), remoteHead);
  assert.equal(sh(checkout, "rev-parse", "HEAD"), before);
});

test("merge: a reviewed merge lands as is while it's up to date, without resolving its conflicts again", async (ctx) => {
  const { root, repo, task, wt } = setup(ctx);
  const origin = join(root, "origin.git");
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");
  let resolved = 0;
  const resolveConflicts: MergeRequest["resolveConflicts"] = async ({ cwd, files }) => {
    resolved++;
    for (const f of files) writeFileSync(join(cwd, f), `resolution ${resolved}\n`);
  };

  let candidate = "";
  await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts,
    verifyVisualReview: async (commit) => { candidate = commit; throw new Error("needs a decision"); } }), /needs a decision/);
  assert.equal(resolved, 1);

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts, reviewedCandidate: candidate });
  assert.equal(resolved, 1, "the agent isn't asked again");
  assert.equal(r.head, candidate);
  assert.equal(sh(origin, "rev-parse", "main"), candidate);
  assert.equal(sh(origin, "show", "main:notes.md"), "resolution 1");
});

test("merge: a reviewed merge is rebuilt once the default branch has moved past it", async (ctx) => {
  const { root, repo, task, wt } = setup(ctx);
  const origin = join(root, "origin.git");
  commitFile(wt, "notes.md", "# Notes\n\nfirst\nfrom the task\n", "task edit");
  landElsewhere(root, "notes.md", "# Notes\n\nfirst\nfrom main\n");
  let resolved = 0;
  const resolveConflicts: MergeRequest["resolveConflicts"] = async ({ cwd, files }) => {
    resolved++;
    for (const f of files) writeFileSync(join(cwd, f), keepBothSides(readFileSync(join(cwd, f), "utf8")));
  };
  let candidate = "";
  await assert.rejects(landTask({ repo, task, workdir: wt, emit, resolveConflicts,
    verifyVisualReview: async (commit) => { candidate = commit; throw new Error("needs a decision"); } }), /needs a decision/);

  const other = join(root, "other");
  sh(other, "pull", "-q", "origin", "main");
  commitFile(other, "later.txt", "later\n", "later");
  sh(other, "push", "-q", "origin", "main");

  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts, reviewedCandidate: candidate });
  assert.equal(resolved, 2);
  assert.notEqual(r.head, candidate);
  assert.equal(sh(origin, "show", "main:later.txt"), "later", "the newer work isn't lost");
});

test("merge: a decision on the branch tip still lands as a merge commit", async (ctx) => {
  const { repo, task, wt, checkout } = setup(ctx);
  commitFile(wt, "feature.txt", "feature\n", "feature");
  const tip = sh(wt, "rev-parse", "HEAD");
  const r = await landTask({ repo, task, workdir: wt, emit, resolveConflicts: noResolve, reviewedCandidate: tip });
  assert.notEqual(r.commit, tip);
  assert.equal(sh(checkout, "rev-parse", "main^2"), tip);
});

/** A repo with a task waiting for review on a visual decision, and the factory that ran it. */
async function taskAwaitingVisualDecision(ctx: TestContext) {
  testHome(ctx);
  const { Store } = await import("@crane/storage");
  const { OperatorActions } = await import("@crane/factory/actions");
  const { Factory } = await import("@crane/factory/runtime");
  const { SimulatedDriver } = await import("@crane/agent-drivers");

  const root = temporaryRoot(ctx, "crane-e2e-");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commitFile(checkout, "README.md", "hi\n", "start");
  sh(checkout, "push", "-q", "-u", "origin", "main");
  sh(root, "clone", "-q", origin, join(root, "other"));

  const store = new Store();
  onFixtureCleanup(ctx, () => store.close());
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "e2e");
  store.setRepoChecks(repo.id, ["true"]);
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 20 });
  const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), `timed out waiting for ${what}`);
  };
  const t = actions.createTask({ kind: "maintenance", title: "Restyle the page", brief: "", repoId: repo.id, autonomy: "propose" });
  factory.start();
  await until(() => store.getTask(t.id)?.status === "needs_review", "review");
  /** The task's branch, as Crane would record it when the agent reported UI work. */
  const holdForDecision = () => {
    const wt = store.getTask(t.id)!.worktree!;
    store.updateTask(t.id, { visualReview: { status: "pending", commit: sh(wt, "rev-parse", "HEAD"), tree: sh(wt, "rev-parse", "HEAD^{tree}"), note: "UI changed", decidedAt: null } });
    return store.getTask(t.id)!.visualReview!.commit;
  };
  /** Someone else's work reaches origin's main. */
  const landOnOrigin = (file: string, text: string) => {
    const other = join(root, "other");
    sh(other, "pull", "-q", "origin", "main");
    mkdirSync(dirname(join(other, file)), { recursive: true });
    commitFile(other, file, text, `elsewhere: ${file}`);
    sh(other, "push", "-q", "origin", "main");
  };
  const decide = async (commit: string) => {
    await actions.recordVisualReview(t.id, { status: "waived", commit, note: "Accepting the risk; page unreviewed at all sizes" });
    await actions.approve(t.id);
    await until(() => store.getTask(t.id)!.status !== "merging", "merge");
  };
  const waivers = () => store.listEvents(t.id).filter((e) => e.message === "Waived candidate visual review").length;
  return { store, stopFactory, t, origin, holdForDecision, landOnOrigin, decide, waivers };
}

test("factory: one waiver is enough when the default branch moved and the merge is clean", async (ctx) => {
  const { store, stopFactory, t, origin, holdForDecision, landOnOrigin, decide, waivers } = await taskAwaitingVisualDecision(ctx);
  try {
    const commit = holdForDecision();
    landOnOrigin("unrelated.txt", "someone else's work\n");
    await decide(commit);
    const events = store.listEvents(t.id);
    assert.equal(store.getTask(t.id)!.status, "merged", events.map((e) => e.message).join("\n"));
    assert.equal(waivers(), 1);
    assert.equal(sh(origin, "show", "main:unrelated.txt"), "someone else's work");
    assert.equal(store.getTask(t.id)!.visualReview!.status, "waived");
  } finally {
    await stopFactory();
  }
});

test("factory: a UI conflict resolution asks once more, then lands exactly the merge that was decided on", async (ctx) => {
  const { store, stopFactory, t, origin, holdForDecision, landOnOrigin, decide, waivers } = await taskAwaitingVisualDecision(ctx);
  try {
    const wt = store.getTask(t.id)!.worktree!;
    mkdirSync(join(wt, "web"), { recursive: true });
    commitFile(wt, "web/app.css", "body { color: red; }\n", "restyle");
    const commit = holdForDecision();
    landOnOrigin("web/app.css", "body { color: blue; }\n");
    const before = sh(origin, "rev-parse", "main");
    await decide(commit);

    const held = store.getTask(t.id)!;
    assert.equal(held.status, "needs_review", store.listEvents(t.id).map((e) => e.message).join("\n"));
    assert.equal(held.visualReview!.status, "pending");
    assert.match(held.visualReview!.note, /resolving conflicts/);
    assert.equal(sh(origin, "rev-parse", "main"), before, "nothing lands before the decision");

    const candidate = held.visualReview!.commit;
    assert.notEqual(candidate, commit);
    await decide(candidate);
    const events = store.listEvents(t.id);
    assert.equal(store.getTask(t.id)!.status, "merged", events.map((e) => e.message).join("\n"));
    assert.equal(waivers(), 2);
    assert.equal(sh(origin, "rev-parse", "main"), candidate);
    assert.equal(events.filter((e) => /conflict with origin\/main/.test(e.message)).length, 1, "the agent resolved them once");
  } finally {
    await stopFactory();
  }
});

test("factory: a task goes from work to review to merged and pushed, through a conflict", async (ctx) => {
  testHome(ctx);
  const { Store } = await import("@crane/storage");
  const { OperatorActions } = await import("@crane/factory/actions");
  const { Factory } = await import("@crane/factory/runtime");
  const { SimulatedDriver } = await import("@crane/agent-drivers");

  const root = temporaryRoot(ctx, "crane-e2e-");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commitFile(checkout, "README.md", "hi\n", "start");
  sh(checkout, "push", "-q", "-u", "origin", "main");

  const store = new Store();
  onFixtureCleanup(ctx, () => store.close());
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "e2e");
  store.setRepoChecks(repo.id, ["true"]);
  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 20 });
  const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
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
    await stopFactory();
  }
});

test("factory: a pre-approved UI task waives visual review and lands once its checks pass", async (ctx) => {
  testHome(ctx);
  const { Store } = await import("@crane/storage");
  const { OperatorActions } = await import("@crane/factory/actions");
  const { Factory } = await import("@crane/factory/runtime");
  const { SimulatedDriver } = await import("@crane/agent-drivers");

  const root = temporaryRoot(ctx, "crane-e2e-");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commitFile(checkout, "README.md", "hi\n", "start");
  sh(checkout, "push", "-q", "-u", "origin", "main");

  const store = new Store();
  onFixtureCleanup(ctx, () => store.close());
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "e2e");
  store.setRepoChecks(repo.id, ["true"]);
  class UiDriver extends SimulatedDriver {
    override async run(ctx: RunContext) {
      const result = await super.run(ctx);
      writeFileSync(join(ctx.cwd, "page.html"), "<h1>Greeting</h1>\n");
      result.report.visualReview = { required: true, reason: "Greeting page needs visual inspection" };
      return result;
    }
  }
  const factory = new Factory(store, new UiDriver(2), { crewSize: 1, tickMs: 20 });
  const stopFactory = onFixtureCleanup(ctx, () => factory.stop());
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
    assert.equal(done.visualReview?.status, "waived");
    assert.ok(events.some(e => e.message === "Visual review waived by pre-approval"));
    assert.equal(sh(origin, "show", "main:page.html"), "<h1>Greeting</h1>");
    assert.deepEqual(done.report?.validation?.map(r => [r.phase, r.status]), [["review", "passed"], ["merge", "passed"]]);
    assert.match(sh(origin, "show", `main:.crane-simulated/${t.id}.md`), /Add a greeting/);
    await until(() => store.listAgents().every((a) => a.state === "idle"), "cleanup");
  } finally {
    await stopFactory();
  }
});

test("actions: approve merges by default, approve only keeps the branch, merge picks it up later", async (ctx) => {
  const { Store } = await import("@crane/storage");
  const { OperatorActions } = await import("@crane/factory/actions");
  const { lastMergeOutcome } = await import("@crane/contracts");
  const store = new Store(join(temporaryRoot(ctx, "crane-"), "t.db"));
  onFixtureCleanup(ctx, () => store.close());
  const actions = new OperatorActions(store);
  const r = store.addRepo({ path: temporaryRoot(ctx, "crane-repo-") });
  const make = (title: string) => {
    const t = store.createTask({ kind: "maintenance", title, brief: "", repoId: r.id, autonomy: "propose" });
    store.updateTask(t.id, { branch: `crane/${t.id}`, agentId: "a-jib", visualReview: { status: "not_required", commit: "test", tree: "test", note: "No UI changes", decidedAt: null } });
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
});
