import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { InstallDiagnostics, INSTALL_PROGRESS_MS, INSTALL_STOP_GRACE_MS, INSTALL_TIMEOUT_MS, runInstall } from "../packages/worktree-deps/src/install-process.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kills: [] as string[],
    kill(signal: string) { this.kills.push(signal); return true; },
  });
  const launch = (() => child) as unknown as typeof spawn;
  const notes: string[] = [];
  const controller = new AbortController();
  const run = () => runInstall("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: "/fixture", onProgress: n => notes.push(n), signal: controller.signal,
  }, launch);
  return { child, notes, controller, run };
}

test("install diagnostics redact complete lines across chunks before truncation", () => {
  const output = new InstallDiagnostics();
  output.push('npm WARN token="secret');
  output.push(' with spaces"\nhttps://user:password@registry.test/pkg?key=hidden\nAuthorization: Bear');
  output.push('er hide-me\n');
  const text = output.snapshot();
  for (const secret of ["secret", "with spaces", "password", "hidden", "hide-me"]) assert.ok(!text.includes(secret), text);
  assert.match(text, /REDACTED/);
  const key = new InstallDiagnostics();
  key.push("-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\n");
  assert.ok(!key.snapshot().includes("private material"));
  for (const line of [
    `npm WARN _auth=${"hide-me".repeat(200)}\n`,
    "npm WARN --password hide-me\n",
    "npm WARN api_key='hide-me with spaces'\n",
    "npm WARN Cookie: hide-me\n",
  ]) {
    const diagnostic = new InstallDiagnostics();
    diagnostic.push(line);
    assert.ok(!diagnostic.snapshot().includes("hide-me"));
    assert.match(diagnostic.snapshot(), /REDACTED/);
  }
});

test("install diagnostics bound noisy and unterminated output and mark omissions", () => {
  const output = new InstallDiagnostics();
  output.push("x".repeat(100_000));
  assert.match(output.snapshot(), /truncated/);
  output.push("secret tail\n");
  for (let i = 0; i < 100; i++) output.push(`${i} ${"y".repeat(600)}\n`);
  const text = output.snapshot();
  assert.ok(text.length < 2200);
  assert.ok(!text.includes("secret tail"));
  assert.match(text, /99 /);
});

test("install progress continues during silence, records bounded stream tails and cleans timers on success", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const { child, notes, run } = fixture();
  const pending = run();
  now += INSTALL_PROGRESS_MS;
  t.mock.timers.tick(INSTALL_PROGRESS_MS);
  assert.match(notes[0]!, /npm ci --no-audit --no-fund.*still running/);
  assert.match(notes[0]!, /no complete output lines/);
  assert.match(notes[0]!, /after 30s/);
  child.stdout.write("download finished\n");
  child.stderr.write("npm WARN token=hide-me\n");
  now += INSTALL_PROGRESS_MS;
  t.mock.timers.tick(INSTALL_PROGRESS_MS);
  assert.match(notes[1]!, /download finished/);
  assert.match(notes[1]!, /after 60s/);
  assert.match(notes[1]!, /last output 30s ago/);
  assert.ok(!notes[1]!.includes("hide-me"));
  child.emit("close", 0, null);
  await pending;
  assert.match(notes[2]!, /completed \(exit 0\)/);
  t.mock.timers.tick(INSTALL_TIMEOUT_MS);
  assert.equal(notes.length, 3);
  assert.deepEqual(child.kills, []);
});

test("install timeout keeps redacted diagnostics and cleans timers", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { child, notes, run } = fixture();
  const pending = run();
  child.stderr.write("npm ERR password=hide-me");
  t.mock.timers.tick(INSTALL_TIMEOUT_MS);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(pending, err => {
    assert.match(String(err), /timed out \(600s limit\)/);
    assert.match(String(err), /REDACTED/);
    assert.ok(!String(err).includes("hide-me"));
    return true;
  });
  const count = notes.length;
  t.mock.timers.tick(INSTALL_TIMEOUT_MS);
  assert.equal(notes.length, count);
});

test("install timeout stops the whole process group and force-kills what ignores it", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { child, controller } = fixture();
  const signals: [number, string][] = [];
  const grouped = Object.assign(child, { pid: 4321 });
  const kill = ((pid: number, signal: string) => { signals.push([pid, signal]); return true; }) as typeof process.kill;
  const launch = ((_cmd: string, _args: string[], options: { detached: boolean }) => {
    assert.equal(options.detached, process.platform !== "win32");
    return grouped;
  }) as unknown as typeof spawn;
  const pending = runInstall("npm", ["ci"], { cwd: "/fixture", signal: controller.signal }, launch, kill);
  t.mock.timers.tick(INSTALL_TIMEOUT_MS);
  const term = process.platform === "win32" ? [] : [[-4321, "SIGTERM"]];
  assert.deepEqual(signals, term);
  controller.abort();
  assert.deepEqual(signals, term, "a second reason to stop doesn't signal again");
  t.mock.timers.tick(INSTALL_STOP_GRACE_MS);
  assert.deepEqual(signals, process.platform === "win32" ? [] : [[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed, "nothing else can hold its close back");
  child.emit("close", null, "SIGKILL");
  await assert.rejects(pending);
  t.mock.timers.tick(INSTALL_TIMEOUT_MS);
  assert.equal(signals.length, process.platform === "win32" ? 0 : 2);
});

test("install outcomes distinguish nonzero exit, spawn errors, and cancellation", async () => {
  for (const outcome of ["exit", "spawn", "cancel"]) {
    const { child, notes, controller, run } = fixture();
    const pending = run();
    if (outcome === "spawn") child.emit("error", Object.assign(new Error("raw secret"), { code: "ENOENT" }));
    if (outcome === "cancel") {
      controller.abort();
      child.emit("error", Object.assign(new Error("raw secret"), { code: "ABORT_ERR" }));
    }
    child.emit("close", outcome === "exit" ? 7 : null, outcome === "cancel" ? "SIGTERM" : null);
    await assert.rejects(pending, err => {
      assert.match(String(err), outcome === "exit" ? /exit 7/ : outcome === "spawn" ? /ENOENT/ : /cancelled/);
      assert.ok(!String(err).includes("raw secret"));
      if (outcome === "cancel") assert.equal((err as Error).name, "AbortError");
      return true;
    });
    assert.equal(notes.length, 1);
  }
});
