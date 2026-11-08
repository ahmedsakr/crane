import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { launchCommand, serveArguments, supervise, type StartChild, type StartRuntime } from "../src/cli/start.js";

function fixture() {
  const controller = new AbortController();
  const events: string[] = [];
  const logs: string[] = [];
  const state = {
    head: "a".repeat(40), builds: 0, waits: 0,
    onBuild: () => 0,
    onWait: () => { controller.abort(); },
    server: undefined as ReturnType<typeof child> | undefined,
  };
  function child(kind: string) {
    let finish!: (result: { code: number | null; signal?: NodeJS.Signals }) => void;
    let stopped = false;
    const done = new Promise<{ code: number | null; signal?: NodeJS.Signals }>(resolve => { finish = resolve; });
    const stop = () => {
      if (!stopped) {
        stopped = true;
        events.push(`stop:${kind}`);
        finish({ code: 0 });
      }
      return done;
    };
    return { done, stop, finish };
  }
  const runtime: StartRuntime = {
    head: async () => state.head,
    launch: (kind, signal): StartChild => {
      assert.equal(signal.aborted, false);
      events.push(kind);
      const process = child(kind);
      if (kind === "build") {
        state.builds++;
        process.finish({ code: state.onBuild() });
      } else state.server = process;
      return process;
    },
    wait: async () => { state.waits++; state.onWait(); },
    log: message => logs.push(message),
  };
  return { state, events, logs, controller, run: () => supervise(runtime, controller.signal), runtime };
}

test("start forwards every serve option, including zero limits and dashboard opt-out", () => {
  assert.deepEqual(serveArguments({ port: 5000, host: "0.0.0.0", agents: 3, driver: "codex", buildDashboard: false, maxTurns: 0, timeLimit: 0 }), [
    "serve", "--port", "5000", "--agents", "3", "--driver", "codex", "--host", "0.0.0.0", "--no-build-dashboard", "--max-turns", "0", "--time-limit", "0",
  ]);
  assert.deepEqual(serveArguments({ port: 4471, agents: 2, driver: "auto" }), ["serve", "--port", "4471", "--agents", "2", "--driver", "auto"]);
});

test("start forwards the public URL, proxy trust and the insecure-HTTP override to serve", () => {
  const base = { port: 4471, agents: 2, driver: "auto" };
  assert.deepEqual(serveArguments({ ...base, host: "127.0.0.1", publicUrl: "https://crane.example.com", trustProxy: true }), [
    "serve", "--port", "4471", "--agents", "2", "--driver", "auto", "--host", "127.0.0.1",
    "--public-url", "https://crane.example.com", "--trust-proxy",
  ]);
  assert.deepEqual(serveArguments({ ...base, host: "0.0.0.0", allowInsecureHttp: true }).slice(-3), ["--host", "0.0.0.0", "--allow-insecure-http"]);
  assert.deepEqual(serveArguments({ ...base, trustProxy: false, allowInsecureHttp: false }), ["serve", "--port", "4471", "--agents", "2", "--driver", "auto"]);
});

test("start forwards TLS file paths unchanged to supervised serve", () => {
  assert.deepEqual(serveArguments({ port: 4471, agents: 2, driver: "auto", tlsCert: "/cert path/fullchain.pem", tlsKey: "/key path/privkey.pem" }).slice(-4), [
    "--tls-cert", "/cert path/fullchain.pem", "--tls-key", "/key path/privkey.pem",
  ]);
});

test("start builds initially, ignores unchanged HEAD, and stops before rebuilding a new commit", async () => {
  const f = fixture();
  f.state.onWait = () => {
    if (f.state.waits === 2) f.state.head = "b".repeat(40);
    if (f.state.waits === 3) f.controller.abort();
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ["build", "serve", "stop:serve", "build", "serve", "stop:serve"]);
  assert.equal(f.state.builds, 2);
});

test("start coalesces commits that arrive during a build before starting serve", async () => {
  const f = fixture();
  f.state.onBuild = () => {
    if (f.state.builds === 1) f.state.head = "c".repeat(40);
    return 0;
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ["build", "build", "serve", "stop:serve"]);
});

test("start exits nonzero on initial build failure and never serves failed output", async () => {
  const f = fixture();
  f.state.onBuild = () => 2;
  assert.equal(await f.run(), 2);
  assert.deepEqual(f.events, ["build"]);
  assert.match(f.logs.join("\n"), /npm run build failed \(exit 2\)/);
});

test("start waits after a failed update, then recovers on the next commit", async () => {
  const f = fixture();
  f.state.onBuild = () => f.state.builds === 2 ? 1 : 0;
  f.state.onWait = () => {
    if (f.state.waits === 1) f.state.head = "b".repeat(40);
    if (f.state.waits === 3) f.state.head = "c".repeat(40);
    if (f.state.waits === 4) f.controller.abort();
  };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ["build", "serve", "stop:serve", "build", "build", "serve", "stop:serve"]);
  assert.match(f.logs.join("\n"), /Waiting for another commit/);
});

test("start propagates an unexpected serve exit without a restart loop", async () => {
  for (const result of [{ code: 7 }, { code: null, signal: "SIGKILL" as const }, { code: 0 }]) {
    const f = fixture();
    f.state.onWait = () => { f.state.server!.finish(result); };
    assert.equal(await f.run(), result.code ?? 1);
    assert.equal(f.state.builds, 1);
    assert.match(f.logs.join("\n"), /crane serve stopped/);
  }
});

test("start cleans up serve when reading HEAD fails", async () => {
  const f = fixture();
  f.state.onWait = () => { f.runtime.head = async () => { throw new Error("git failed"); }; };
  await assert.rejects(f.run(), /git failed/);
  assert.deepEqual(f.events, ["build", "serve", "stop:serve"]);
});

test("start does not launch serve when interrupted during a build or a restart", async () => {
  const f = fixture();
  f.state.onBuild = () => { f.controller.abort(); return 0; };
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.events, ["build"]);

  const g = fixture();
  g.state.onWait = () => {
    g.state.head = "b".repeat(40);
    const stop = g.state.server!.stop;
    g.state.server!.stop = () => { g.controller.abort(); return stop(); };
  };
  assert.equal(await g.run(), 0);
  assert.deepEqual(g.events, ["build", "serve", "stop:serve"]);
});

function processFixture(build: boolean) {
  const controller = new AbortController();
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    kill: (signal: string) => { signals.push(signal); return true; },
  });
  const launch = ((command: string, args: string[], options: unknown) => {
    assert.equal(command, "fixture");
    assert.deepEqual(args, ["arg"]);
    assert.deepEqual(options, { cwd: "/fixture", stdio: "inherit", detached: process.platform !== "win32" });
    return child;
  }) as unknown as typeof spawn;
  const kill = ((pid: number, signal: string) => {
    assert.equal(pid, -12345);
    signals.push(`group:${signal}`);
    return true;
  }) as typeof process.kill;
  const managed = launchCommand({
    command: "fixture", args: ["arg"], cwd: "/fixture", signal: controller.signal, build, launch, killGroup: kill,
  });
  return { controller, child, managed, signals };
}

test("start shutdown asks serve to stop gracefully and bounds an unresponsive child", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = processFixture(false);
  f.controller.abort();
  assert.deepEqual(f.signals, ["SIGTERM"]);
  const stopping = f.managed.stop();
  assert.deepEqual(f.signals, ["SIGTERM"], "repeated stop is idempotent");
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.signals, ["SIGTERM", process.platform === "win32" ? "SIGKILL" : "group:SIGKILL"]);
  f.child.emit("exit", null, "SIGKILL");
  assert.deepEqual(await stopping, { code: null, signal: "SIGKILL" });
});

test("start cancels the build process group and clears its forced-stop timer on exit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = processFixture(true);
  f.controller.abort();
  f.child.emit("exit", null, "SIGTERM");
  assert.deepEqual(await f.managed.done, { code: null, signal: "SIGTERM" });
  t.mock.timers.tick(20_000);
  assert.deepEqual(f.signals, [process.platform === "win32" ? "SIGTERM" : "group:SIGTERM"]);
});

test("start records spawn failures and releases signal handlers after normal exit", async () => {
  const f = processFixture(false);
  f.child.emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(await f.managed.done, { code: null, error: "spawn ENOENT" });
  f.controller.abort();
  assert.deepEqual(f.signals, []);

  const g = processFixture(false);
  g.child.emit("exit", 0, null);
  assert.deepEqual(await g.managed.done, { code: 0, signal: null });
  g.controller.abort();
  assert.deepEqual(g.signals, []);
});
