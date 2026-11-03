import { spawn } from "node:child_process";
import type { ValidationRun } from "@crane/contracts";
import { git } from "../core/git.js";
import { elapsed } from "./elapsed.js";

const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Shorter than the factory's own stop grace, so a stopping factory sees its checks end. */
const CHECK_STOP_GRACE_MS = 3000;
/** Reports are rewritten whole on every update. Keep the end of a noisy check, where its verdict is. */
const MAX_LOG_CHARS = 1024 * 1024;

interface CheckExit {
  code: number | null;
  /** Why it ended, when that wasn't simply finishing. */
  note: string | null;
  /** It ended without giving a verdict on the candidate. */
  noVerdict: boolean;
  logs: string;
}

/**
 * Run a check in its own process group, so stopping it stops its test runners
 * too: they'd otherwise keep going in a worktree that's about to be reused or
 * removed. `execFile` can't start a group, and only signals the shell it started.
 */
function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckExit> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    let omitted = 0;
    let problem: string | null = null;
    let forced: NodeJS.Timeout | undefined;
    const collect = (chunk: string) => {
      logs += chunk;
      if (logs.length <= MAX_LOG_CHARS) return;
      omitted += logs.length - MAX_LOG_CHARS;
      logs = logs.slice(-MAX_LOG_CHARS);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);

    const signalGroup = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      if (forced) return;
      signalGroup("SIGTERM");
      forced = setTimeout(() => {
        signalGroup("SIGKILL");
        // Something that left the group may still hold the pipes, and `close` waits for them.
        child.stdout.destroy();
        child.stderr.destroy();
      }, CHECK_STOP_GRACE_MS);
    };
    const limit = setTimeout(() => {
      problem = `Stopped after ${elapsed(timeoutMs)}, the most one check may run`;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });

    child.once("error", (err) => {
      problem ??= `Couldn't run it: ${err.message}`;
    });
    child.once("close", (code, killedBy) => {
      clearTimeout(limit);
      clearTimeout(forced);
      signal?.removeEventListener("abort", stop);
      // A spawn that failed "closes" with a negative code, which no command exited with.
      const exitCode = child.pid ? code : null;
      resolve({
        code: exitCode,
        note: problem ?? (killedBy ? `Killed by ${killedBy}` : exitCode ? `Exited with code ${exitCode}` : null),
        noVerdict: problem !== null || exitCode === null,
        logs: omitted ? `[${omitted} earlier characters omitted]\n${logs}` : logs,
      });
    });
  });
}

/** Only operator settings supply commands. Agents cannot configure these gates. */
export async function runChecks(cwd: string, commands: string[], phase: ValidationRun["phase"],
  record: (run: ValidationRun) => void, signal?: AbortSignal, timeoutMs = CHECK_TIMEOUT_MS): Promise<void> {
  const commit = await git(cwd, "rev-parse", "HEAD");
  const results: ValidationRun[] = [];
  for (const command of commands.length ? commands : [null]) {
    signal?.throwIfAborted();
    const start = Date.now();
    let result: ValidationRun = { phase, commit, command, status: "unconfigured", exitCode: null,
      logs: "No repository checks configured by the operator", durationMs: 0 };
    if (command) {
      const exit = await runCommand(command, cwd, timeoutMs, signal);
      // Stopped by the operator or the factory. That says nothing about the candidate, so it isn't evidence.
      signal?.throwIfAborted();
      result = { ...result,
        status: exit.noVerdict || exit.code === 126 || exit.code === 127 ? "blocked" : exit.code === 0 ? "passed" : "failed",
        exitCode: exit.code,
        logs: exit.note ? `${exit.logs}\n${exit.note}` : exit.logs };
    }
    result.durationMs = Date.now() - start;
    results.push(result);
    record(result);
  }
  // A command that edits or commits code has not verified the candidate we will push.
  if (await git(cwd, "rev-parse", "HEAD") !== commit || await git(cwd, "status", "--porcelain", "--untracked-files=no")) {
    const result: ValidationRun = { phase, commit, command: null, status: "blocked", exitCode: null,
      logs: "Checks changed the candidate commit or tracked files", durationMs: 0 };
    record(result);
    results.push(result);
  }
  if (results.some(r => r.status !== "passed")) throw new Error(`Repository checks did not pass (${results.filter(r => r.status !== "passed").map(r => r.status).join(", ")})`);
}
