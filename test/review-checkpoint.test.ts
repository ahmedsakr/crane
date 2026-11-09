import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparedDependencyIdentity } from "@crane/worktree-deps";
import { SimulatedDriver } from "@crane/agent-drivers";
import type { RunContext, RunResult } from "@crane/agent-protocol";
import { Store } from "@crane/storage";
import { OperatorActions } from "@crane/factory/actions";
import { Factory } from "@crane/factory/runtime";
import { changedInputs, type ReviewInputs } from "../packages/factory/src/review-checkpoint.js";
import { dependencyFingerprint } from "../packages/worktree-deps/src/deps.js";
import { sh } from "./support/git.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

class CountingDriver extends SimulatedDriver {
  runs = 0;
  override run(ctx: RunContext): Promise<RunResult> {
    this.runs++;
    return super.run(ctx);
  }
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 1500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/**
 * A task stopped with the factory during its second review check: its agent is
 * done, the first check passed, and the second never gave a verdict.
 */
async function interruptedDuringChecks(opts: { preApprove?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crane-checkpoint-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "checkpoint");
  const log = join(root, "checks.log");
  const go = join(root, "go");
  const first = `echo first >> '${log}'`;
  const second = `echo second >> '${log}'; until [ -f '${go}' ]; do sleep 0.02; done`;
  store.setRepoChecks(repo.id, [first, second]);
  const task = actions.createTask({ kind: "maintenance", title: "Fix the retries", brief: "", repoId: repo.id, autonomy: "propose" });
  if (opts.preApprove) store.setPreApproval(task.id, true);
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  const factory = new Factory(store, new SimulatedDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  await until(() => logged().includes("second"), "the second check to start");
  await factory.stop();
  assert.equal(store.getTask(task.id)!.status, "queued");
  return { store, actions, repo, task, logged, first, second, release: () => writeFileSync(go, "") };
}

test("review checkpoint: a restart resumes the remaining checks without the agent", async () => {
  const s = await interruptedDuringChecks();
  const before = s.store.getTask(s.task.id)!;
  assert.deepEqual(before.reviewCheckpoint?.passed, [s.first]);
  s.release();
  const driver = new CountingDriver(2);
  const factory = new Factory(s.store, driver, { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => s.store.getTask(s.task.id)?.status === "needs_review", "review");
    const done = s.store.getTask(s.task.id)!;
    assert.equal(driver.runs, 0, "the agent isn't resumed");
    assert.deepEqual(s.logged(), ["first", "second", "second"], "only the interrupted check runs again");
    assert.deepEqual(done.report?.validation?.map((r) => [r.command, r.status]), [[s.first, "passed"], [s.second, "passed"]]);
    assert.equal(done.report?.summary, before.report?.summary, "the agent's report is kept");
    assert.equal(done.visualReview?.commit, before.visualReview?.commit);
    assert.equal(done.reviewCheckpoint, null, "it ends with the work run");
    assert.ok(s.store.listEvents(s.task.id).some((e) => /resuming on .* without it: 1 already passed/.test(e.message)));
  } finally {
    await factory.stop();
    s.store.close();
  }
});

test("review checkpoint: changed environment or check list reruns every check, still without the agent", async () => {
  for (const change of ["environment", "checks"] as const) {
    const s = await interruptedDuringChecks();
    s.release();
    if (change === "environment") process.env.CRANE_TEST_CHECK_INPUT = "changed";
    else s.store.setRepoChecks(s.repo.id, [s.first, s.second, "true"]);
    const driver = new CountingDriver(2);
    const factory = new Factory(s.store, driver, { crewSize: 1, tickMs: 10 });
    factory.start();
    try {
      await until(() => s.store.getTask(s.task.id)?.status === "needs_review", "review");
      assert.equal(driver.runs, 0);
      assert.deepEqual(s.logged(), ["first", "second", "first", "second"], change);
    } finally {
      delete process.env.CRANE_TEST_CHECK_INPUT;
      await factory.stop();
      s.store.close();
    }
  }
});

test("review checkpoint: a changed candidate goes back to its agent and is validated from the start", async () => {
  const s = await interruptedDuringChecks();
  s.release();
  writeFileSync(join(s.store.getTask(s.task.id)!.worktree!, "later.txt"), "edited after finalizing\n");
  const driver = new CountingDriver(2);
  const factory = new Factory(s.store, driver, { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => s.store.getTask(s.task.id)?.status === "needs_review", "review");
    const done = s.store.getTask(s.task.id)!;
    assert.equal(driver.runs, 1, "the agent carries on");
    assert.deepEqual(s.logged(), ["first", "second", "first", "second"]);
    assert.ok(done.report?.changedFiles.includes("later.txt"));
  } finally {
    await factory.stop();
    s.store.close();
  }
});

test("review checkpoint: cancelling resumed checks stops them and records no verdict", async () => {
  const s = await interruptedDuringChecks();
  const driver = new CountingDriver(2);
  const factory = new Factory(s.store, driver, { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => s.logged().length === 3, "the check to run again");
    s.actions.cancel(s.task.id);
    await until(() => !s.store.getTask(s.task.id)!.reviewCheckpoint, "the run to end");
    const done = s.store.getTask(s.task.id)!;
    assert.equal(done.status, "cancelled");
    assert.equal(driver.runs, 0);
    assert.deepEqual(done.report?.validation?.map((r) => r.command), [s.first], "nothing recorded for the stopped check");
  } finally {
    await factory.stop();
    s.store.close();
  }
});

test("review checkpoint: merge checks still run in full after reused review results", async () => {
  const s = await interruptedDuringChecks({ preApprove: true });
  s.release();
  const factory = new Factory(s.store, new CountingDriver(2), { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => s.store.getTask(s.task.id)?.status === "merged", "the merge");
    const phases = s.store.getTask(s.task.id)!.report!.validation!.map((r) => [r.phase, r.command]);
    assert.deepEqual(phases, [["review", s.first], ["review", s.second], ["merge", s.first], ["merge", s.second]]);
  } finally {
    await factory.stop();
    s.store.close();
  }
});

test("review checkpoint: results are reusable only when every input matches", () => {
  const inputs: ReviewInputs = { commit: "c", tree: "t", checks: ["a"], dependencies: "d", environment: "e" };
  const passed = { ...inputs, passed: ["a"] };
  assert.deepEqual(changedInputs(passed, inputs), []);
  assert.deepEqual(changedInputs(passed, { ...inputs, tree: "other" }), ["the candidate"]);
  assert.deepEqual(changedInputs(passed, { ...inputs, checks: ["b"] }), ["the configured checks"]);
  assert.deepEqual(changedInputs(passed, { ...inputs, dependencies: "other" }), ["the installed dependencies"]);
  assert.deepEqual(changedInputs(passed, { ...inputs, environment: "other" }), ["the environment"]);
  assert.deepEqual(changedInputs({ ...passed, dependencies: null }, { ...inputs, dependencies: null }), ["the installed dependencies"], "unverified never matches itself");
});

test("dependency identity: follows the verified install, and is null when it can't be verified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crane-identity-"));
  sh(dir, "init", "-q");
  assert.equal(await preparedDependencyIdentity(dir), "no-dependencies");
  mkdirSync(join(dir, "node_modules"));
  assert.equal(await preparedDependencyIdentity(dir), null, "installed, but nothing pins it");

  writeFileSync(join(dir, "package.json"), `{"name":"x"}`);
  writeFileSync(join(dir, "package-lock.json"), `{"lockfileVersion":3,"packages":{}}`);
  assert.equal(await preparedDependencyIdentity(dir), null, "not prepared");

  writeFileSync(join(dir, "node_modules", ".crane-dependencies"), await dependencyFingerprint(dir));
  writeFileSync(join(dir, "node_modules", ".package-lock.json"), `{"packages":{"node_modules/a":{"version":"1.0.0"}}}`);
  const identity = await preparedDependencyIdentity(dir);
  assert.ok(identity);
  assert.equal(await preparedDependencyIdentity(dir), identity, "stable");

  writeFileSync(join(dir, "node_modules", ".package-lock.json"), `{"packages":{"node_modules/a":{"version":"2.0.0"}}}`);
  const reinstalled = await preparedDependencyIdentity(dir);
  assert.ok(reinstalled);
  assert.notEqual(reinstalled, identity, "a different install");

  writeFileSync(join(dir, "package.json"), `{"name":"x","dependencies":{"a":"2"}}`);
  assert.equal(await preparedDependencyIdentity(dir), null, "preparation is out of date");
});
