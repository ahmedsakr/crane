import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { testArguments } from "../scripts/run-test-groups.ts";
import { runTestSuites, type TestRuntime } from "../scripts/test-runner.ts";

function fixture(platform: NodeJS.Platform = "linux") {
  const child = Object.assign(new EventEmitter(), { pid: 123, kill: (signal: string) => { killed.push([123, signal]); return true; } });
  const signals = new EventEmitter();
  const killed: [number, string][] = [];
  const calls: unknown[][] = [];
  const diagnostics: string[] = [];
  const runtime: TestRuntime = {
    platform, signals,
    kill: (pid, signal) => { killed.push([pid, String(signal)]); return true; },
    spawn: ((...args: unknown[]) => { calls.push(args); return child as ChildProcess; }) as typeof spawn,
  };
  const run = () => runTestSuites(["test/a.test.ts", "test/b.test.ts"], { cwd: "/fixture", runtime, diagnostic: (message) => diagnostics.push(message), stopGraceMs: 10 });
  return { child, signals, killed, calls, diagnostics, run, runtime };
}

test("test runner: delegates one isolated invocation with inherited diagnostics and no shell", async () => {
  const f = fixture();
  const result = f.run();
  assert.deepEqual(f.calls, [[process.execPath, ["--import", "tsx", "--test", "test/a.test.ts", "test/b.test.ts"], { cwd: "/fixture", stdio: "inherit", detached: true }]]);
  let done = false;
  void result.then(() => { done = true; });
  f.child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(done, false, "wait for close, not just exit");
  f.child.emit("close", 0, null);
  assert.equal(await result, 0);
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("test runner: preserves nonzero Node exits and rejects missing exit evidence", async () => {
  for (const [code, signal, expected] of [[1, null, 1], [7, null, 7], [null, null, 1], [undefined, null, 1], [null, "SIGTERM", 143]] as const) {
    const f = fixture();
    const result = f.run();
    f.child.emit("close", code, signal);
    assert.equal(await result, expected);
  }
});

test("test runner: launch errors keep their diagnostic and cannot be followed by a passing result", async () => {
  const f = fixture();
  const result = f.run();
  f.child.emit("error", new Error("spawn EPERM"));
  f.child.emit("close", 0, null);
  assert.equal(await result, 1);
  assert.match(f.diagnostics.join("\n"), /spawn EPERM/);
});

test("test runner: SIGINT and SIGTERM reach the POSIX process group and stay nonzero even if Node exits zero", async () => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const f = fixture();
    const result = f.run();
    f.signals.emit(signal);
    assert.deepEqual(f.killed, [[-123, signal]]);
    f.child.emit("close", 0, null);
    assert.equal(await result, expected);
    assert.match(f.diagnostics.join("\n"), /cancelled/);
    assert.equal(f.signals.listenerCount(signal), 0);
  }
});

test("test runner: an unresponsive cancellation escalates, and repeated signals force stop", async () => {
  const f = fixture();
  const result = f.run();
  f.signals.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.killed, [[-123, "SIGTERM"], [-123, "SIGKILL"]]);
  f.signals.emit("SIGINT");
  assert.deepEqual(f.killed.at(-1), [-123, "SIGKILL"]);
  f.child.emit("close", null, "SIGKILL");
  assert.equal(await result, 143);
});

test("test runner: signalling failures are diagnosed and Windows forwards to the child", async () => {
  const f = fixture();
  f.runtime.kill = () => { throw new Error("signal denied"); };
  const result = f.run();
  f.signals.emit("SIGINT");
  f.child.emit("close", null, "SIGINT");
  assert.equal(await result, 130);
  assert.match(f.diagnostics.join("\n"), /signal denied/);
  const windows = fixture("win32");
  const winResult = windows.run();
  windows.signals.emit("SIGTERM");
  assert.deepEqual(windows.killed, [[123, "SIGTERM"]]);
  windows.child.emit("close", null, "SIGTERM");
  assert.equal(await winResult, 143);
});

test("test runner: refuses empty/duplicate lists and malformed command arguments", () => {
  assert.throws(() => runTestSuites([], { cwd: "." }), /nonempty, unique/);
  assert.throws(() => runTestSuites(["a", "a"], { cwd: "." }), /nonempty, unique/);
  assert.deepEqual(testArguments([]), { groups: undefined, list: false });
  assert.deepEqual(testArguments(["--full", "--list"]), { groups: undefined, list: true });
  assert.deepEqual(testArguments(["--group", "web", "--group", "backend"]), { groups: ["web", "backend"], list: false });
  for (const args of [["--group"], ["--group", "--list"], ["--full", "--group", "web"], ["--typo"]]) assert.throws(() => testArguments(args));
});
