import "../src/application.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ValidationRun } from "@crane/contracts";
import { runChecks } from "../packages/factory/src/checks.js";
import { runInstall } from "../packages/worktree-deps/src/install-process.js";
import { sh } from "./support/git.js";

/** A committed repo for checks to run in, and a place outside it for commands to leave marks. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-trees-"));
  const repo = join(root, "repo");
  sh(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "file"), "x");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "first");
  return { repo, mark: (name: string) => join(root, name), done: () => rmSync(root, { recursive: true, force: true }) };
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(25);
  assert.ok(condition(), what);
}

/** A shell whose child outlives it unless the whole group is stopped. Marks `after` if it does. */
const lingering = (ready: string, after: string) => `touch '${ready}'; (sleep 1; touch '${after}') & wait`;

test("a cancelled check stops its process tree, runs nothing further, and records no evidence", async () => {
  const s = setup();
  try {
    const [ready, after, next] = ["ready", "after", "next"].map(s.mark) as [string, string, string];
    const runs: ValidationRun[] = [];
    const ac = new AbortController();
    const checks = runChecks(s.repo, [lingering(ready, after), `touch '${next}'`], "review", (r) => runs.push(r), { signal: ac.signal });
    await until(() => existsSync(ready), "the check started");
    ac.abort();
    await assert.rejects(checks, { name: "AbortError" });
    assert.deepEqual(runs, [], "a stopped check says nothing about the candidate");
    await delay(1300);
    assert.equal(existsSync(after), false, "its child was stopped with it");
    assert.equal(existsSync(next), false, "the next check never ran");
  } finally { s.done(); }
});

test("a check past its time limit is blocked, says why, and stops its process tree", async () => {
  const s = setup();
  try {
    const [ready, after] = ["ready", "after"].map(s.mark) as [string, string];
    const runs: ValidationRun[] = [];
    await assert.rejects(runChecks(s.repo, [`echo started; ${lingering(ready, after)}`], "merge", (r) => runs.push(r), { timeoutMs: 200 }), /did not pass \(blocked\)/);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "blocked");
    assert.equal(runs[0]!.exitCode, null);
    assert.match(runs[0]!.logs, /started/);
    assert.match(runs[0]!.logs, /Stopped after 0\.2s, the most one check may run/);
    await delay(1300);
    assert.equal(existsSync(after), false, "its child was stopped with it");
  } finally { s.done(); }
});

test("a check that ignores SIGTERM is killed, so the crew slot comes back", async () => {
  const s = setup();
  try {
    const runs: ValidationRun[] = [];
    const started = Date.now();
    await assert.rejects(runChecks(s.repo, ["trap '' TERM; sleep 30"], "review", (r) => runs.push(r), { timeoutMs: 100 }), /blocked/);
    assert.ok(Date.now() - started < 10_000, "it didn't wait out the sleep");
    assert.equal(runs[0]!.status, "blocked");
  } finally { s.done(); }
});

test("check verdicts: exit codes, a command that can't run, and the bound on output", async () => {
  const s = setup();
  try {
    const run = async (command: string) => {
      const runs: ValidationRun[] = [];
      await runChecks(s.repo, [command], "review", (r) => runs.push(r)).catch(() => {});
      return runs[0]!;
    };
    const passed = await run("echo out; echo err >&2");
    assert.deepEqual([passed.status, passed.exitCode], ["passed", 0]);
    assert.deepEqual(passed.logs.trim().split("\n").sort(), ["err", "out"], "both streams, as they arrive");

    const failed = await run("echo broken; exit 3");
    assert.deepEqual([failed.status, failed.exitCode], ["failed", 3]);
    assert.match(failed.logs, /broken\n\nExited with code 3$/);

    for (const [command, code] of [["no-such-command-crane", 127], ["./file", 126]] as const) {
      const blocked = await run(command);
      assert.deepEqual([blocked.status, blocked.exitCode], ["blocked", code]);
    }

    const killed = await run("kill -KILL $$");
    assert.deepEqual([killed.status, killed.exitCode], ["blocked", null]);
    assert.match(killed.logs, /Killed by SIGKILL/);

    const noisy = await run("head -c 3000000 /dev/zero | tr '\\0' x; echo; echo the-verdict");
    assert.equal(noisy.status, "passed");
    assert.ok(noisy.logs.length < 1.1 * 1024 * 1024, "bounded");
    assert.match(noisy.logs, /^\[\d+ earlier characters omitted\]\n/);
    assert.match(noisy.logs, /the-verdict\n$/);

    const storage = await run("echo 'ENOSPC: write failed' >&2; head -c 3000000 /dev/zero | tr '\\0' x; echo; echo 'SQLITE_FULL: database or disk is full' >&2; exit 3");
    assert.deepEqual([storage.status, storage.exitCode], ["failed", 3]);
    assert.match(storage.logs, /^\[\d+ earlier characters omitted\]/);
    assert.match(storage.logs, /Storage error evidence[\s\S]*\[stderr\] ENOSPC: write failed/);
    assert.match(storage.logs, /\[stderr\] SQLITE_FULL: database or disk is full/);
    assert.match(storage.logs, /availableBytes=\d+/);
    assert.ok(storage.logs.length < 1.1 * 1024 * 1024);
  } finally { s.done(); }
});

test("a cancelled install returns even though its script's child still holds the pipes", async () => {
  const s = setup();
  try {
    const [ready, after] = ["ready", "after"].map(s.mark) as [string, string];
    const ac = new AbortController();
    const started = Date.now();
    const install = runInstall("/bin/sh", ["-c", `touch '${ready}'; (sleep 30; touch '${after}') & wait`], { cwd: s.repo, signal: ac.signal });
    await until(() => existsSync(ready), "the install started");
    ac.abort();
    await assert.rejects(install, { name: "AbortError" });
    assert.ok(Date.now() - started < 10_000, "it didn't wait for the child");
  } finally { s.done(); }
});
