import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunError } from "@crane/agent-protocol";
import { RUNNER_LIMITS, type RunnerJob } from "@crane/contracts";
import { incomingBundlePath } from "../packages/factory/src/remote/paths.js";
import { bundleOf, claim, commitIn, containerClone, finalText, remoteSetup, type RemoteSetup } from "./support/remote-fixture.js";
import { sh } from "./support/git.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000500020100a5e3d1a50000000049454e44ae426082", "hex");

test("remote dispatch: a work job's commits land as a fast-forward of the commit Crane sent", async (t) => {
  const s = await remoteSetup(t);
  const sent = sh(s.wt, "rev-parse", "HEAD");
  const usage: unknown[] = [];
  const run = s.driver.run(s.ctx({ onUsage: (u) => usage.push(u) }));
  const job = await claim(s);
  assert.equal(job.kind, "work");
  assert.equal(job.tip, sent);
  assert.equal(job.branch, s.branch);
  assert.equal(job.task.worktree, null, "Crane's paths never reach the container");
  assert.ok(!JSON.stringify(job).includes(s.wt));

  const dir = await containerClone(t, s, job);
  sh(dir, "checkout", "-q", "--detach", job.tip!);
  const returned = commitIn(dir, "remote.txt", "from the container\n");
  sh(dir, "update-ref", "refs/heads/result", "HEAD");
  const shot = s.actions.storeJobScreenshot(s.runner(), job.id, "view.png", PNG);
  s.actions.returnJob(s.runner(), job.id, {
    outcome: "succeeded",
    finalText: finalText({
      summary: "Did it remotely", findings: [], changedFiles: ["remote.txt"],
      validation: [{ command: "npm test", status: "passed" }],
      screenshots: [{ path: "view.png", caption: "View at 1280 × 800" }],
    }),
    usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 2, model: "m" },
  }, bundleOf(dir, "refs/heads/result", `^${sent}`));

  const { report } = await run;
  assert.equal(sh(s.wt, "rev-parse", "HEAD"), returned);
  assert.equal(sh(s.wt, "symbolic-ref", "--short", "HEAD"), s.branch);
  assert.equal(readFileSync(join(s.wt, "remote.txt"), "utf8"), "from the container\n");
  assert.equal(report.summary, "Did it remotely");
  assert.equal(report.validation, undefined, "validation never comes from the container");
  assert.deepEqual(report.screenshots, [{ path: shot.path, caption: "View at 1280 × 800" }]);
  assert.equal(sh(s.wt, "status", "--porcelain"), "", "uploaded screenshots are ignored");
  assert.equal((usage[0] as { costUsd: number }).costUsd, 0.5);
  assert.equal(existsSync(incomingBundlePath(job.id)), false);
});

/** Dispatch, have the container return what `prepare` builds, and expect Crane to refuse it unchanged. */
async function expectRefused(t: TestContext, s: RemoteSetup, prepare: (dir: string, job: RunnerJob) => Buffer, reason: RegExp, beforeReturn?: () => void) {
  const head = sh(s.wt, "rev-parse", "HEAD");
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  const dir = await containerClone(t, s, job);
  const bundle = prepare(dir, job);
  beforeReturn?.();
  const status = sh(s.wt, "status", "--porcelain");
  s.actions.returnJob(s.runner(), job.id, { outcome: "succeeded", finalText: "done" }, bundle);
  await assert.rejects(run, (err) => err instanceof AgentRunError && !err.transient && reason.test(err.message));
  assert.equal(sh(s.wt, "rev-parse", "HEAD"), head, "the worktree is unchanged");
  assert.equal(sh(s.wt, "status", "--porcelain"), status);
  assert.ok(s.events.some((e) => e.type === "note" && /^Refused the commits .*worktree is unchanged$/.test(e.message)), "a task note says why");
  return job;
}

test("remote dispatch: a commit that isn't a fast-forward is refused", async (t) => {
  const s = await remoteSetup(t);
  await expectRefused(t, s, (dir, job) => {
    sh(dir, "checkout", "-q", "--detach", job.base);
    commitIn(dir, "other.txt", "elsewhere\n");
    sh(dir, "update-ref", "refs/heads/result", "HEAD");
    return bundleOf(dir, "refs/heads/result", `^${job.base}`);
  }, /isn't a fast-forward/);
});

test("remote dispatch: a bundle with two refs is refused", async (t) => {
  const s = await remoteSetup(t);
  await expectRefused(t, s, (dir, job) => {
    sh(dir, "checkout", "-q", "--detach", job.tip!);
    commitIn(dir, "a.txt", "a\n");
    sh(dir, "update-ref", "refs/heads/a", "HEAD");
    sh(dir, "update-ref", "refs/heads/b", "HEAD");
    return bundleOf(dir, "refs/heads/a", "refs/heads/b", `^${job.tip}`);
  }, /2 refs/);
});

test("remote dispatch: a corrupt bundle is refused", async (t) => {
  const s = await remoteSetup(t);
  await expectRefused(t, s, () => Buffer.from("# v2 git bundle\nnot really\n"), /didn't verify/);
});

test("remote dispatch: commits returned to a dirty worktree are refused, leaving its edits", async (t) => {
  const s = await remoteSetup(t);
  await expectRefused(t, s, (dir, job) => {
    sh(dir, "checkout", "-q", "--detach", job.tip!);
    commitIn(dir, "remote.txt", "x\n");
    sh(dir, "update-ref", "refs/heads/result", "HEAD");
    return bundleOf(dir, "refs/heads/result", `^${job.tip}`);
  }, /uncommitted changes/, () => writeFileSync(join(s.wt, "first.txt"), "edited here\n"));
  assert.equal(readFileSync(join(s.wt, "first.txt"), "utf8"), "edited here\n");
});

test("remote dispatch: an oversized bundle is refused before Git reads it", async (t) => {
  const s = await remoteSetup(t);
  const head = sh(s.wt, "rev-parse", "HEAD");
  const run = s.driver.run(s.ctx());
  const job = await claim(s);
  // Sparse, so the test doesn't hold 256 MB: only the size is checked first.
  writeFileSync(incomingBundlePath(job.id), "");
  truncateSync(incomingBundlePath(job.id), RUNNER_LIMITS.bundleBytes + 1);
  s.store.runners.finishJob(job.id, "returned", { outcome: "succeeded", finalText: "done" });
  await assert.rejects(run, /more than the 256 MB Crane accepts/);
  assert.equal(sh(s.wt, "rev-parse", "HEAD"), head);
  assert.ok(s.events.some((e) => /^Refused the commits/.test(e.message)));
  assert.equal(existsSync(incomingBundlePath(job.id)), false);
});

test("remote dispatch: a resolved conflict is copied into the index and working tree without moving HEAD", async (t) => {
  const s = await remoteSetup(t);
  const main = commitIn(s.checkout, "README.md", "main side\n");
  commitIn(s.wt, "README.md", "task side\n");
  sh(s.wt, "checkout", "-q", "--detach", main);
  assert.throws(() => sh(s.wt, "merge", "--no-ff", "--no-edit", s.branch));
  const run = s.driver.run(s.ctx({ job: { kind: "resolve_conflicts", phase: "edit", base: "main", files: ["README.md"] } }));
  const job = await claim(s);
  assert.equal(job.kind, "resolve_conflicts");
  assert.equal(job.base, main);

  const dir = await containerClone(t, s, job);
  sh(dir, "checkout", "-q", "--detach", job.base);
  assert.throws(() => sh(dir, "merge", "--no-edit", job.tip!));
  writeFileSync(join(dir, "README.md"), "both sides\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-q", "--no-edit");
  sh(dir, "update-ref", "refs/heads/result", "HEAD");
  s.actions.returnJob(s.runner(), job.id, { outcome: "succeeded", finalText: finalText({ summary: "Resolved" }) },
    bundleOf(dir, "refs/heads/result", `^${job.base}`, `^${job.tip}`));

  await run;
  assert.equal(sh(s.wt, "rev-parse", "HEAD"), main, "HEAD never moves");
  assert.ok(sh(s.wt, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "the merge is still in progress for Crane to commit");
  assert.equal(readFileSync(join(s.wt, "README.md"), "utf8"), "both sides\n");
  assert.equal(sh(s.wt, "diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(sh(s.wt, "diff", "--cached", "--name-only"), "README.md\nfirst.txt");
});

test("remote dispatch: a check fix is copied in as edits on the merge commit, which stays HEAD", async (t) => {
  const s = await remoteSetup(t);
  const main = sh(s.checkout, "rev-parse", "main");
  sh(s.wt, "checkout", "-q", "--detach", main);
  sh(s.wt, "merge", "--no-ff", "--no-edit", s.branch);
  const merge = sh(s.wt, "rev-parse", "HEAD");
  const run = s.driver.run(s.ctx({ job: { kind: "fix_checks", base: "main", commit: merge, failures: [{ command: "npm test", exitCode: 1, logs: "boom" }] } }));
  const job = await claim(s);
  assert.equal(job.base, merge);
  const dir = await containerClone(t, s, job);
  sh(dir, "checkout", "-q", "--detach", merge);
  commitIn(dir, "first.txt", "fixed\n");
  sh(dir, "update-ref", "refs/heads/result", "HEAD");
  s.actions.returnJob(s.runner(), job.id, { outcome: "succeeded", finalText: "fixed" }, bundleOf(dir, "refs/heads/result", `^${merge}`));

  await run;
  assert.equal(sh(s.wt, "rev-parse", "HEAD"), merge);
  assert.equal(readFileSync(join(s.wt, "first.txt"), "utf8"), "fixed\n");
  assert.equal(sh(s.wt, "diff", "--cached", "--name-only"), "first.txt");
});
