import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface TestRuntime {
  spawn: typeof spawn;
  signals: {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
  kill: typeof process.kill;
  platform: NodeJS.Platform;
}
const runtime: TestRuntime = { spawn, signals: process, kill: process.kill.bind(process), platform: process.platform };

export interface TestRunOptions {
  cwd: string;
  /** In-process lifecycle fixtures can supply a child; production always uses Node. */
  runtime?: TestRuntime;
  diagnostic?: (message: string) => void;
  stopGraceMs?: number;
}

function signalExit(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 1);
}

/**
 * One native node:test invocation, with its normal per-file process isolation.
 * No shell, output parser, reporter replacement, result cache or piped diagnostics.
 * Wait for close (including stdio), and never turn missing exit evidence into success.
 */
export function runTestSuites(suites: readonly string[], options: TestRunOptions): Promise<number> {
  if (!suites.length || new Set(suites).size !== suites.length) throw new Error("Test execution needs a nonempty, unique suite list");
  const host = options.runtime ?? runtime;
  const diagnostic = options.diagnostic ?? ((message: string) => console.error(message));
  return new Promise((resolve) => {
    const child = host.spawn(process.execPath, ["--import", "tsx", "--test", ...suites], {
      cwd: options.cwd, stdio: "inherit", detached: host.platform !== "win32",
    });
    let cancelled: NodeJS.Signals | undefined;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forward = (signal: NodeJS.Signals) => {
      try {
        if (host.platform !== "win32" && child.pid) host.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        diagnostic(`Cannot signal test runner (${signal}): ${String(error)}`);
      }
    };
    const cancel = (signal: NodeJS.Signals) => {
      if (cancelled) { forward("SIGKILL"); return; }
      cancelled = signal;
      diagnostic(`Test execution cancelled (${signal})`);
      forward(signal);
      timer = setTimeout(() => forward("SIGKILL"), options.stopGraceMs ?? 5_000);
      timer.unref();
    };
    const interrupt = () => cancel("SIGINT");
    const terminate = () => cancel("SIGTERM");
    host.signals.on("SIGINT", interrupt);
    host.signals.on("SIGTERM", terminate);
    child.once("error", (error) => { failed = true; diagnostic(`Cannot run test suites: ${String(error)}`); });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      host.signals.removeListener("SIGINT", interrupt);
      host.signals.removeListener("SIGTERM", terminate);
      if (cancelled) resolve(signalExit(cancelled));
      else if (signal) resolve(signalExit(signal));
      else if (failed || typeof code !== "number" || code < 0) {
        diagnostic("Test execution has no successful process exit evidence");
        resolve(1);
      } else resolve(code);
    });
  });
}
