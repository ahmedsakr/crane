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

interface SuperviseState {
  active?: StartChild;
  serverExit?: Outcome;
  attempted?: string;
  hasServed: boolean;
}

/** What the supervisor does after a rebuild attempt: an exit code, poll again now, or wait for the next poll. */
type RebuildStep = number | "recheck" | "wait";

/** Serial builds keep commits arriving during a build from starting stale output. */
export async function supervise(runtime: StartRuntime, signal: AbortSignal): Promise<number> {
  const state: SuperviseState = { hasServed: false };
  try {
    while (!signal.aborted) {
      if (state.serverExit) {
        runtime.log(`crane serve stopped (${describe(state.serverExit)}).`);
        return succeeded(state.serverExit) ? 0 : state.serverExit.code || 1;
      }
      const head = await runtime.head();
      if (signal.aborted) break;
      if (head !== state.attempted) {
        const step = await rebuild(runtime, signal, state, head);
        if (typeof step === "number") return step;
        if (step === "recheck") continue;
      }
      await runtime.wait(signal);
    }
    return 0;
  } finally {
    await state.active?.stop();
  }
}

/** Stops any running factory, builds `head`, and serves it when the build passed and HEAD hasn't moved. */
async function rebuild(runtime: StartRuntime, signal: AbortSignal, state: SuperviseState, head: string): Promise<RebuildStep> {
  if (state.active) {
    runtime.log(`Commit ${head.slice(0, 12)} detected. Stopping the factory before rebuilding…`);
    await state.active.stop();
    state.active = undefined;
    state.serverExit = undefined;
  }
  if (signal.aborted) return 0;
  state.attempted = head;
  runtime.log(`Building Crane at ${head.slice(0, 12)} with npm run build…`);
  state.active = runtime.launch("build", signal);
  const built = await state.active.done;
  state.active = undefined;
  if (signal.aborted) return 0;
  if (!succeeded(built)) {
    runtime.log(`npm run build failed (${describe(built)}). Factory remains stopped. Check the build output; if dependencies changed, run npm install yourself.`);
    if (!state.hasServed) return built.code || 1;
    runtime.log("Waiting for another commit, or stop and rerun crane start after fixing the build.");
    return "wait";
  }
  // HEAD may have moved while npm was running. Build the latest tree before serving.
  if (await runtime.head() !== head) return "recheck";
  if (signal.aborted) return 0;
  runtime.log("Starting crane serve. Watching checkout HEAD for new commits…");
  state.active = runtime.launch("serve", signal);
  void state.active.done.then(result => { state.serverExit = result; });
  state.hasServed = true;
  return "wait";
}

export interface LaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  /** Builds are stopped as a whole process group, so npm's children stop too. */
  build: boolean;
  launch?: typeof spawn;
  killGroup?: typeof process.kill;
}

/** Separate process groups prevent terminal Ctrl-C from also interrupting the child's shutdown. */
export function launchCommand(options: LaunchOptions): StartChild {
  const { command, args, cwd, signal, build, launch = spawn, killGroup = process.kill } = options;
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
        ? launchCommand({ command: "npm", args: ["run", "build"], cwd: root, signal, build: true })
        // Always use the rebuilt entry point, even when the supervisor was started via tsx.
        : launchCommand({
          command: process.execPath, args: [join(root, "dist", "cli", "index.js"), ...serveArguments(opts)],
          cwd: process.cwd(), signal, build: false,
        }),
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
