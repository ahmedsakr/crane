import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { factoryRoot } from "../core/paths.js";
import type { ServeOptions } from "./serve.js";

const exec = promisify(execFile);
const POLL_MS = 1000;
const STOP_TIMEOUT_MS = 10_000;

interface Outcome { code: number | null; signal?: NodeJS.Signals | null; error?: string }
export interface StartChild {
  done: Promise<Outcome>;
  stop(): Promise<Outcome>;
}
export interface StartRuntime {
  head(): Promise<string>;
  launch(kind: "build" | "serve", signal: AbortSignal): StartChild;
  wait(signal: AbortSignal): Promise<void>;
  log(message: string): void;
}

const succeeded = (result: Outcome) => result.code === 0 && !result.signal && !result.error;
const describe = (result: Outcome) => result.error ?? (result.signal ? `signal ${result.signal}` : `exit ${result.code}`);

/** Serial builds keep commits arriving during a build from starting stale output. */
export async function supervise(runtime: StartRuntime, signal: AbortSignal): Promise<number> {
  let active: StartChild | undefined;
  let serverExit: Outcome | undefined;
  let attempted: string | undefined;
  let hasServed = false;
  try {
    while (!signal.aborted) {
      if (serverExit) {
        runtime.log(`crane serve stopped (${describe(serverExit)}).`);
        return succeeded(serverExit) ? 0 : serverExit.code || 1;
      }
      const head = await runtime.head();
      if (signal.aborted) break;
      if (head !== attempted) {
        if (active) {
          runtime.log(`Commit ${head.slice(0, 12)} detected. Stopping the factory before rebuilding…`);
          await active.stop();
          active = undefined;
          serverExit = undefined;
        }
        if (signal.aborted) break;
        attempted = head;
        runtime.log(`Building Crane at ${head.slice(0, 12)} with npm run build…`);
        active = runtime.launch("build", signal);
        const built = await active.done;
        active = undefined;
        if (signal.aborted) break;
        if (!succeeded(built)) {
          runtime.log(`npm run build failed (${describe(built)}). Factory remains stopped. Check the build output; if dependencies changed, run npm install yourself.`);
          if (!hasServed) return built.code || 1;
          runtime.log("Waiting for another commit, or stop and rerun crane start after fixing the build.");
        } else {
          // HEAD may have moved while npm was running. Build the latest tree before serving.
          if (await runtime.head() !== head) continue;
          if (signal.aborted) break;
          runtime.log("Starting crane serve. Watching checkout HEAD for new commits…");
          active = runtime.launch("serve", signal);
          void active.done.then(result => { serverExit = result; });
          hasServed = true;
        }
      }
      await runtime.wait(signal);
    }
    return 0;
  } finally {
    await active?.stop();
  }
}

/** Separate process groups prevent terminal Ctrl-C from also interrupting the child's shutdown. */
export function launchCommand(
  command: string, args: string[], cwd: string, signal: AbortSignal, build: boolean,
  launch = spawn, killGroup = process.kill,
): StartChild {
  const grouped = process.platform !== "win32";
  const child = launch(command, args, { cwd, stdio: "inherit", detached: grouped });
  let finished = false;
  let stopping: Promise<Outcome> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const kill = (force: boolean) => {
    try {
      if (grouped && child.pid && (build || force)) killGroup(-child.pid, force ? "SIGKILL" : "SIGTERM");
      else child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(`Couldn't stop ${command}: ${String(error)}`);
    }
  };
  let onAbort: () => void;
  const done = new Promise<Outcome>(resolve => {
    const finish = (result: Outcome) => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.once("error", error => finish({ code: null, error: error.message }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
  const stop = () => {
    if (!finished && !stopping) {
      stopping = done;
      kill(false);
      timer = setTimeout(() => kill(true), STOP_TIMEOUT_MS);
    }
    return done;
  };
  onAbort = () => { void stop(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return { done, stop };
}

export function serveArguments(opts: ServeOptions): string[] {
  return [
    "serve", "--port", String(opts.port), "--agents", String(opts.agents), "--driver", opts.driver,
    ...(opts.host === undefined ? [] : ["--host", opts.host]),
    ...(opts.buildDashboard === false ? ["--no-build-dashboard"] : []),
    ...(opts.maxTurns === undefined ? [] : ["--max-turns", String(opts.maxTurns)]),
    ...(opts.timeLimit === undefined ? [] : ["--time-limit", String(opts.timeLimit)]),
  ];
}

export async function start(opts: ServeOptions): Promise<number> {
  const root = factoryRoot();
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, timeout: 10_000 })).stdout.trim();
  // Installed tarballs cannot rebuild themselves; don't accidentally watch a parent repository.
  if (!existsSync(join(root, "src", "cli", "index.ts")) || !existsSync(join(root, "scripts", "build.mjs")) ||
      realpathSync(await git("rev-parse", "--show-toplevel")) !== realpathSync(root)) {
    throw new Error("crane start needs a Crane source checkout with dependencies installed. Use crane serve for an installed package.");
  }
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    return await supervise({
      head: () => git("rev-parse", "--verify", "HEAD"),
      launch: (kind, signal) => kind === "build"
        ? launchCommand("npm", ["run", "build"], root, signal, true)
        // Always use the rebuilt entry point, even when the supervisor was started via tsx.
        : launchCommand(process.execPath, [join(root, "dist", "cli", "index.js"), ...serveArguments(opts)], process.cwd(), signal, false),
      wait: signal => delay(POLL_MS, undefined, { signal }).catch(error => {
        if (!signal.aborted) throw error;
      }),
      log: message => console.log(message),
    }, controller.signal);
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
