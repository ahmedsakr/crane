import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHandleCommand } from "../packages/agent-drivers/src/claude-guard.js";
import { checkResultsSummary } from "../packages/agent-drivers/src/claude-evidence.js";
import { ClaudeStream } from "../packages/agent-drivers/src/claude-stream.js";
import { CHECKS_DIR, LOST_EXIT, STILL_RUNNING_EXIT, checkRecordsSince, readCheckRecord, type CheckRecord } from "../packages/agent-drivers/src/check-results.js";
import { checkHandleBrief } from "../packages/agent-drivers/src/prompt-briefs.js";
import { specifiers } from "./support/imports.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const driverSrc = join(root, "packages", "agent-drivers", "src");
const handle = join(root, "packages", "agent-drivers", "dist", "check-handle.js");
const node = JSON.stringify(process.execPath);

function worktree(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "crane-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function handleRun(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [handle, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
}

function record(cwd: string, name: string): CheckRecord | null {
  return readCheckRecord(join(cwd, CHECKS_DIR), name);
}

test("check handle: the package build emits it, and driver sources point agents at the build", () => {
  assert.ok(existsSync(handle), "npm run build:packages compiles dist/check-handle.js");
  assert.equal(checkHandleCommand(), `node '${handle}'`);
});

test("check handle: run records the check's own exit code, logs its output, and exits with it", (t) => {
  const cwd = worktree(t);
  const passed = handleRun(cwd, ["run", "ok", "--", node, "-e", JSON.stringify("console.log('# pass 3')")]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /# pass 3[\s\S]*crane-check ok: passed \(exit 0\)/);
  assert.equal(record(cwd, "ok")?.exitCode, 0);
  assert.equal(record(cwd, "ok")?.status, "passed");
  assert.equal(readFileSync(join(cwd, CHECKS_DIR, "ok.log"), "utf8"), "# pass 3\n");
  assert.equal(readFileSync(join(cwd, CHECKS_DIR, ".gitignore"), "utf8"), "*\n", "records never get committed");

  // Passing output doesn't make a failing process pass.
  const failed = handleRun(cwd, ["run", "bad", "--", node, "-e", JSON.stringify("console.log('# fail 0'); process.exit(3)")]);
  assert.equal(failed.status, 3);
  assert.equal(record(cwd, "bad")?.status, "failed");
  assert.equal(record(cwd, "bad")?.exitCode, 3);
  assert.equal(handleRun(cwd, ["wait", "bad"]).status, 3, "wait returns the recorded exit code");
});

test("check handle: wait is bounded while a check runs, then returns its result", async (t) => {
  const cwd = worktree(t);
  const runner = spawn(process.execPath, [handle, "run", "slow", "--", node, "-e", JSON.stringify("setTimeout(() => process.exit(4), 1500)")], { cwd, stdio: "ignore" });
  const exited = new Promise((resolve) => runner.on("exit", resolve));
  const early = handleRun(cwd, ["wait", "slow", "--timeout", "0"]);
  assert.equal(early.status, STILL_RUNNING_EXIT, early.stdout + early.stderr);
  assert.match(early.stdout, /still running after .*Run wait again/);
  const done = handleRun(cwd, ["wait", "slow", "--timeout", "20"]);
  assert.equal(done.status, 4, done.stdout + done.stderr);
  assert.match(done.stdout, /crane-check slow: failed \(exit 4\)/);
  assert.equal(await exited, 4);
});

test("check handle: a runner that stopped without a result is reported as unknown, never passed", (t) => {
  const cwd = worktree(t);
  const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid!;
  const dir = join(cwd, CHECKS_DIR);
  mkdirSync(dir, { recursive: true });
  const lost: CheckRecord = {
    name: "lost", command: "npm test", pid: gone, status: "running", exitCode: null, signal: null,
    startedAt: new Date().toISOString(), finishedAt: null, log: join(dir, "lost.log"),
  };
  writeFileSync(join(dir, "lost.json"), JSON.stringify(lost));
  const out = handleRun(cwd, ["wait", "lost"]);
  assert.equal(out.status, LOST_EXIT);
  assert.match(out.stdout, /outcome is unknown/);
  assert.equal(handleRun(cwd, ["run", "../x", "--", "true"]).status, 64, "names can't leave the checks directory");
});

test("check handle: the Claude stream adds this invocation's recorded results to the report", (t) => {
  const cwd = worktree(t);
  handleRun(cwd, ["run", "earlier", "--", node, "-e", "0"]);
  const stream = new ClaudeStream({ cwd, signal: new AbortController().signal, emit: () => {} }, { allowed: [], denied: [] });
  handleRun(cwd, ["run", "typecheck", "--", node, "-e", "0"]);
  handleRun(cwd, ["run", "test", "--", node, "-e", JSON.stringify("process.exit(1)")]);
  stream.handle({ type: "result", subtype: "success", result: "Done" });
  const summary = stream.finish({ code: 0, stderr: "" }).report.summary;
  assert.match(summary, /Crane check handle results for this invocation/);
  assert.match(summary, /typecheck: passed \(exit 0\)/);
  assert.match(summary, /test: failed \(exit 1\)/);
  assert.doesNotMatch(summary, /earlier/, "records from before the invocation describe an earlier one");
  assert.equal(checkResultsSummary(checkRecordsSince(join(cwd, "missing"), new Date(0))), "");
});

test("check handle: briefed only when available, and imports only Node", () => {
  assert.equal(checkHandleBrief(undefined), "");
  const brief = checkHandleBrief("node '/x/check-handle.js'");
  assert.match(brief, /node '\/x\/check-handle\.js' run <name> -- <command>/);
  assert.match(brief, /Exit 75 means it is still running/);
  assert.deepEqual(specifiers(join(driverSrc, "check-handle.ts")).filter((spec) => !spec.startsWith("node:")), ["./check-results.js"]);
  assert.deepEqual(specifiers(join(driverSrc, "check-results.ts")).filter((spec) => !spec.startsWith("node:")), []);
});
