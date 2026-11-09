import "../src/application.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Repo, Task, ValidationRun } from "@crane/contracts";
import type { FixChecksJob } from "@crane/agent-protocol";
import { systemPrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";
import { landTask, MergeError, type MergeRequest } from "../packages/factory/src/merge.js";
import { failureExcerpt, fixableFailures } from "../packages/factory/src/merge-fixes.js";
import { temporaryRoot } from "./support/fixtures.js";
import { sh } from "./support/git.js";

function commitFile(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", msg);
}

/** Passes only while the feature uses the API version that's current. */
const CHECK = 'grep -qx "uses: $(cat api.txt)" feature.txt';

/**
 * A merge that git builds cleanly but that fails its check: the task's feature
 * uses API v1, and main moved the API to v2 without touching the same lines.
 */
function setup(ctx: TestContext) {
  const root = temporaryRoot(ctx, "crane-merge-fix-");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, checkout);
  sh(checkout, "checkout", "-q", "-b", "main");
  commitFile(checkout, "api.txt", "v1\n", "start");
  sh(checkout, "push", "-q", "-u", "origin", "main");
  sh(checkout, "branch", "crane/feature-t1");
  const repo: Repo = { id: "r-x", name: "x", path: checkout, defaultBranch: "main", isFactory: false, addedAt: "" };
  const task = { id: "t-1", title: "Add the feature", branch: "crane/feature-t1", worktree: join(root, "wt") } as Task;
  sh(checkout, "worktree", "add", "-q", task.worktree!, task.branch!);
  commitFile(task.worktree!, "feature.txt", "uses: v1\n", "feature");

  const other = join(root, "other");
  sh(root, "clone", "-q", origin, other);
  commitFile(other, "api.txt", "v2\n", "move the API to v2");
  sh(other, "push", "-q", "origin", "main");
  const runs: ValidationRun[] = [];
  const notes: string[] = [];
  const req: MergeRequest = {
    repo, task, workdir: task.worktree!, checks: [CHECK],
    emit: (_type, message) => { notes.push(message); },
    recordValidation: (run) => { runs.push(run); },
    resolveConflicts: async () => { throw new Error("should not be asked to resolve conflicts"); },
  };
  return { origin, checkout, wt: task.worktree!, req, runs, notes, before: sh(origin, "rev-parse", "main") };
}

test("merge fixes: a clean merge that fails its checks is fixed in the merge commit, checked again, and pushed", async (ctx) => {
  const { origin, wt, req, runs, notes } = setup(ctx);
  const asked: Parameters<NonNullable<MergeRequest["fixChecks"]>>[0][] = [];
  const result = await landTask({ ...req, fixChecks: async (fix) => {
    asked.push(fix);
    assert.equal(sh(fix.cwd, "rev-parse", "HEAD"), fix.commit, "HEAD is the merge that failed");
    writeFileSync(join(fix.cwd, "feature.txt"), "uses: v2\n");
  } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.base, "origin/main");
  assert.deepEqual(asked[0]!.failures.map((f) => [f.command, f.exitCode]), [[CHECK, 1]]);
  assert.deepEqual(runs.map((r) => r.status), ["failed", "passed"]);
  assert.equal(runs[1]!.commit, result.head, "the checks passed on what was pushed");
  assert.notEqual(runs[0]!.commit, result.head);
  assert.equal(sh(origin, "rev-parse", "main"), result.head);
  const parents = sh(wt, "show", "-s", "--format=%P", result.head).split(" ");
  assert.equal(parents.length, 2, "still one merge commit, not a merge plus a fix");
  assert.equal(sh(wt, "show", `${result.head}:feature.txt`), "uses: v2");
  assert.equal(sh(wt, "show", `${result.head}:api.txt`), "v2");
  assert.ok(notes.some((n) => /Asking an agent to fix the merge/.test(n)));
  assert.ok(notes.some((n) => /changed 1 file to fix the merge: feature.txt/.test(n)));
});

test("merge fixes: an agent's commits on top of the merge are folded into it", async (ctx) => {
  const { origin, wt, req } = setup(ctx);
  const result = await landTask({ ...req, fixChecks: async ({ cwd }) => {
    commitFile(cwd, "feature.txt", "uses: v2\n", "fix");
  } });
  assert.equal(sh(origin, "rev-parse", "main"), result.head);
  assert.equal(sh(wt, "show", "-s", "--format=%P", result.head).split(" ").length, 2);
});

test("merge fixes: a fix that changes nothing, or still fails, goes back with nothing pushed", async (ctx) => {
  for (const edit of [null, "uses: v3\n"]) {
    const { origin, wt, req, runs, notes, before } = setup(ctx);
    let asked = 0;
    await assert.rejects(landTask({ ...req, fixChecks: async ({ cwd }) => {
      asked++;
      if (edit) writeFileSync(join(cwd, "feature.txt"), edit);
    } }), edit ? /checks did not pass/ : (err) => err instanceof MergeError && /changed nothing/.test(err.message));
    assert.equal(asked, 1, "one fix per candidate");
    assert.deepEqual(runs.map((r) => r.status), edit ? ["failed", "failed"] : ["failed"]);
    if (edit) assert.ok(notes.includes("Merge checks still fail after the agent's fix"));
    assert.equal(sh(origin, "rev-parse", "main"), before);
    assert.equal(sh(wt, "status", "--porcelain", "--untracked-files=no"), "");
  }
});

test("merge fixes: a fixer that fails or moves HEAD away leaves the worktree clean on the merge", async (ctx) => {
  const fixers: NonNullable<MergeRequest["fixChecks"]>[] = [
    async ({ cwd }) => {
      writeFileSync(join(cwd, "feature.txt"), "half done\n");
      throw new Error("agent stopped");
    },
    async ({ cwd }) => {
      sh(cwd, "checkout", "-q", "--detach", "HEAD^1");
      writeFileSync(join(cwd, "api.txt"), "v9\n");
    },
  ];
  for (const [i, fixChecks] of fixers.entries()) {
    const { origin, wt, req, before } = setup(ctx);
    let merge = "";
    await assert.rejects(landTask({ ...req, fixChecks: async (fix) => {
      merge = fix.commit;
      return fixChecks(fix);
    } }), i === 0 ? /agent stopped/ : /moved HEAD off the merge/);
    assert.equal(sh(wt, "rev-parse", "HEAD"), merge);
    assert.equal(sh(wt, "status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(sh(origin, "rev-parse", "main"), before);
  }
});

test("merge fixes: checks that didn't judge the merge, or no fixer, hand it straight back", async (ctx) => {
  const blocked = setup(ctx);
  let asked = false;
  await assert.rejects(landTask({ ...blocked.req, checks: [CHECK, "exit 127"], fixChecks: async () => { asked = true; } }), /checks did not pass/);
  assert.equal(asked, false, "a blocked check never judged the merge");
  const plain = setup(ctx);
  await assert.rejects(landTask(plain.req), /checks did not pass/);
  assert.deepEqual(plain.runs.map((r) => r.status), ["failed"]);
});

test("merge fixes: only failed checks are fixable, and only when nothing else went wrong", () => {
  const run = (status: ValidationRun["status"], command: string | null = "npm test") =>
    ({ phase: "merge", commit: "c", command, status, exitCode: null, logs: "", durationMs: 0 }) satisfies ValidationRun;
  assert.deepEqual(fixableFailures([run("passed", "a"), run("failed", "b")]).map((r) => r.command), ["b"]);
  assert.deepEqual(fixableFailures([run("failed"), run("blocked", null)]), []);
  assert.deepEqual(fixableFailures([run("unconfigured", null)]), []);
});

test("merge fixes: a long log keeps its failing tests and its end", () => {
  assert.equal(failureExcerpt("short\n"), "short\n");
  const passing = Array.from({ length: 2000 }, (_, i) => `ok ${i} - fine\n  ---\n  duration_ms: 1\n  ...`).join("\n");
  const failing = "not ok 2001 - holds one factory state\n  ---\n  error: |-\n    2 !== 1\n  ...";
  const logs = `${passing}\n${failing}\n${passing}\n# fail 1\nExited with code 1`;
  const excerpt = failureExcerpt(logs, 4000);
  assert.ok(excerpt.length < 4500);
  assert.ok(excerpt.includes(failing), "the failing test and its details");
  assert.ok(excerpt.endsWith("# fail 1\nExited with code 1"), "the verdict at the end");
  assert.match(excerpt, /characters of output omitted/);
});

test("merge fixes: the agent is shown the failed merge and told to leave git to Crane", () => {
  const task = { id: "t-1", title: "Add the feature", brief: "Add it", branch: "crane/feature-t1", kind: "maintenance",
    autonomy: "propose", report: { summary: "Added it", findings: [], changedFiles: [] } } as unknown as Task;
  const repo = { name: "x", defaultBranch: "main" } as Repo;
  const job: FixChecksJob = { kind: "fix_checks", base: "origin/main", commit: "abc1234",
    failures: [{ command: "npm test", exitCode: 1, logs: "not ok 1 - a ```fenced``` name" }] };
  const system = systemPrompt(task, repo, job, { checks: ["npm test"] });
  assert.match(system, /HEAD is detached at merge commit abc1234/);
  assert.match(system, /Do not commit/);
  assert.match(system, /Never delete, skip, or weaken a test/);
  assert.match(system, /change nothing and explain why/);
  assert.match(system, /Crane runs these checks itself/);
  const user = userPrompt(task, job);
  assert.match(user, /^# Fix merge checks: Add the feature/);
  assert.match(user, /## `npm test` \(exit 1\)\n\n````text\nnot ok 1 - a ```fenced``` name\n````/, "a fence the log can't close");
  assert.match(user, /What the task did: Added it/);
  assert.match(user, /Merge-check fix of candidate abc1234/);
});
