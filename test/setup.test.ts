import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import { inspectSetup, MIN_NODE_VERSION, probeCommand, probeSqlite, setupCommand, type ProbeResult } from "../src/cli/setup.js";

const ok: ProbeResult = { ok: true, detail: "Version check passed" };
const missing: ProbeResult = { ok: false, detail: "Executable not found" };

function fixture(unavailable: string[] = []) {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      nodeVersion: "22.0.0", env: {} as NodeJS.ProcessEnv,
      command: async (bin: string) => { calls.push(bin); return unavailable.includes(bin) ? missing : ok; },
      sqlite: async () => ok,
    },
  };
}

test("setup: Node minimum agrees with the package engine and checks version boundaries", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.engines.node, `>=${MIN_NODE_VERSION.replace(/\.0$/, "")}`);
  for (const [version, expected] of [
    ["18.20.8", false], ["20.18.9", false], ["20.19.0", true], ["20.19.1", true],
    ["20.20.0", true], ["21.0.0", true], ["22.0.0", true], ["invalid", false],
  ] as const) {
    const f = fixture();
    f.runtime.nodeVersion = version;
    const report = await inspectSetup(f.runtime);
    assert.equal(report.ready, expected, version);
    assert.equal(report.checks.find(c => c.id === "node")!.status, expected ? "pass" : "fail", version);
    if (!expected) assert.match(report.checks.find(c => c.id === "node")!.fix!, /Install Node.js/);
    assert.equal(report.checks.length, 7, "a failed Node check does not hide other results");
  }
});

test("setup: either real agent suffices, but simulated alone does not", async () => {
  for (const unavailable of [[], ["claude"], ["codex"], ["claude", "codex"]]) {
    const f = fixture(unavailable);
    const report = await inspectSetup(f.runtime);
    assert.equal(report.ready, unavailable.length < 2);
    assert.equal(report.checks.find(c => c.id === "agent")!.status, unavailable.length < 2 ? "pass" : "fail");
    for (const id of ["claude-code", "codex"]) {
      const bin = id === "claude-code" ? "claude" : "codex";
      assert.equal(report.checks.find(c => c.id === id)!.status, unavailable.includes(bin) ? "info" : "pass");
    }
    assert.deepEqual(f.calls.sort(), ["claude", "codex", "git", "npm"]);
    assert.match(report.unchecked.join(";"), /Agent login and API access/);
  }
});

test("setup: missing npm, Git, and a broken native binding are actionable failures", async () => {
  const f = fixture(["npm", "git"]);
  f.runtime.sqlite = async () => ({ ok: false, detail: "Native binding unavailable" });
  const report = await inspectSetup(f.runtime);
  assert.equal(report.ready, false);
  assert.deepEqual(report.checks.filter(c => c.status === "fail").map(c => c.id), ["npm", "git", "sqlite"]);
  for (const check of report.checks.filter(c => c.status === "fail")) assert.ok(check.fix);
  assert.match(report.checks.find(c => c.id === "sqlite")!.fix!, /npm install/);
});

test("setup: the installed SQLite native binding can execute an in-memory query", async () => {
  assert.deepEqual(await probeSqlite(), { ok: true, detail: "Native binding loaded and in-memory query passed" });
});

test("setup: agent executable overrides are passed literally", async () => {
  const f = fixture();
  f.runtime.env = { CRANE_CLAUDE_BIN: "/tools/Claude Code/claude", CRANE_CODEX_BIN: "/tools/codex;echo secret" };
  assert.equal((await inspectSetup(f.runtime)).ready, true);
  assert.deepEqual(f.calls, ["npm", "git", "/tools/Claude Code/claude", "/tools/codex;echo secret"]);
});

function processFixture() {
  const child = new EventEmitter();
  const launch = ((bin: string, args: string[], options: unknown) => {
    assert.equal(bin, "/path with spaces/agent");
    assert.deepEqual(args, ["--version"]);
    assert.deepEqual(options, { stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
    return child;
  }) as unknown as typeof spawn;
  return { child, result: probeCommand("/path with spaces/agent", launch) };
}

test("setup: version probes distinguish success, exit failure, signal, missing and inaccessible executables", async () => {
  for (const [code, signal, expected, detail] of [
    [0, null, true, /passed/], [2, null, false, /exited with 2/],
    [null, null, false, /unknown status/], [null, "SIGKILL", false, /SIGKILL.*10s/],
  ] as const) {
    const f = processFixture();
    f.child.emit("exit", code, signal);
    const result = await f.result;
    assert.equal(result.ok, expected);
    assert.match(result.detail, detail);
  }
  for (const code of ["ENOENT", "EACCES"]) {
    const f = processFixture();
    f.child.emit("error", Object.assign(new Error("not exposed"), { code }));
    f.child.emit("exit", 0, null);
    const result = await f.result;
    assert.equal(result.ok, false, "an error cannot be overwritten by an exit");
    assert.match(result.detail, code === "ENOENT" ? /not found/ : /EACCES/);
    assert.doesNotMatch(result.detail, /not exposed/);
  }
  const throwing = (() => { throw new Error("not exposed"); }) as unknown as typeof spawn;
  assert.deepEqual(await probeCommand("bad", throwing), { ok: false, detail: "Could not start version check" });
});

test("setup: command prints readable fixes or JSON with the matching exit status", async t => {
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { lines.push(args.join(" ")); });
  const previousExitCode = process.exitCode;
  try {
    for (const unavailable of [[], ["git", "claude", "codex"]]) {
      const report = await inspectSetup(fixture(unavailable).runtime);
      for (const json of [true, false]) {
        lines.length = 0;
        const program = new Command("crane").addCommand(setupCommand(async () => report));
        await program.parseAsync(["node", "crane", "setup", ...(json ? ["--json"] : [])]);
        assert.equal(process.exitCode, report.ready ? 0 : 1);
        if (json) assert.deepEqual(JSON.parse(lines.join("\n")), report);
        else {
          const output = lines.join("\n");
          assert.match(output, /Crane setup/);
          assert.match(output, report.ready ? /Required dependencies are available/ : /Setup needs attention/);
          assert.match(output, /Not checked: Agent login/);
          if (!report.ready) assert.match(output, /Install Git/);
        }
      }
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("setup: help and invalid arguments never start probes", async () => {
  for (const args of [["--help"], ["--install"], ["extra"]]) {
    const setup = setupCommand(async () => { assert.fail("unexpected probe"); })
      .exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const program = new Command("crane").addCommand(setup);
    await assert.rejects(program.parseAsync(["node", "crane", "setup", ...args]), (error: unknown) =>
      error instanceof CommanderError && error.exitCode === (args[0] === "--help" ? 0 : 1));
  }
});
