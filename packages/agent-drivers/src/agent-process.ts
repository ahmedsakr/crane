import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { AgentRunError, type RunContext, type RunResult } from "@crane/agent-protocol";
import { readMessages } from "./cli.js";

const KILL_AFTER_MS = 3000;
const STDERR_TAIL_CHARS = 4000;
const STDERR_EXCERPT_CHARS = 500;

/** The agent's CLI exited before it got going again on an earlier session. */
export class SessionNotResumed extends Error {}

/** How the process ended, for a stream to weigh against what it heard. */
export interface AgentExit {
  code: number | null;
  /** The end of what the process wrote to stderr. */
  stderr: string;
}

/** Turns one CLI's messages into task events, and decides how the run went. */
export interface AgentStream {
  /** One message. A throw costs only that message (see `readMessages`). */
  handle(msg: Record<string, any>): void;
  /** The process failed to start, or couldn't be signalled. `finish` may still follow. */
  onProcessError?(): void;
  /** The process has closed: return the run's result, or throw why it has none. */
  finish(exit: AgentExit): RunResult;
}

export interface AgentProcess {
  bin: string;
  /** What messages call this CLI, e.g. "Codex". */
  label: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which keeps long briefs out of the process list. */
  prompt: string;
  /** The session being continued, if any. */
  resume?: string;
  stream: AgentStream;
  ctx: Pick<RunContext, "cwd" | "signal" | "emit">;
}

export function cancelledRun(sessionId: string | null): AgentRunError {
  return new AgentRunError("Cancelled by operator", { sessionId });
}

/** The part of a process's stderr worth putting in a message. */
export function stderrExcerpt(stderr: string): string {
  return stderr.trim().slice(-STDERR_EXCERPT_CHARS);
}

/**
 * Each agent runs in its own process group, so stopping it stops the shells,
 * installs and test runners it started too. Signalling only the CLI left them
 * running in a worktree the next run was about to prepare and use: an orphaned
 * `npm ci` kept emptying `node_modules` after the factory had restarted.
 */
const grouped = process.platform !== "win32";
/** Groups still running, for the factory's exit to stop: they no longer hear its terminal's Ctrl-C. */
const liveGroups = new Set<number>();
let exitHooked = false;

function signalAgent(child: ChildProcess, name: NodeJS.Signals) {
  try {
    if (grouped && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // Already gone.
  }
}

function trackGroup(child: ChildProcess): () => void {
  const pid = child.pid;
  if (!grouped || !pid) return () => {};
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      for (const group of liveGroups) {
        try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
      }
    });
  }
  liveGroups.add(pid);
  return () => liveGroups.delete(pid);
}

/**
 * A stuck agent may ignore SIGTERM, and the factory waits only a few seconds
 * for agents to stop before it exits. Don't hold a crew slot, or outlive that.
 * Returns how to stop listening.
 */
function stopOnAbort(child: ChildProcess, signal: AbortSignal): () => void {
  const onAbort = () => {
    signalAgent(child, "SIGTERM");
    setTimeout(() => {
      signalAgent(child, "SIGKILL");
      // Something that left the group may still hold the pipes, and `close` waits for them.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, KILL_AFTER_MS).unref();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function keepTail(output: Readable): () => string {
  let tail = "";
  output.on("data", (d) => {
    tail = (tail + String(d)).slice(-STDERR_TAIL_CHARS);
  });
  return () => tail;
}

/** Run one agent CLI to its end, feeding its stdout to `stream`, which decides the outcome. */
export function runAgentProcess(run: AgentProcess): Promise<RunResult> {
  const { bin, label, stream } = run;
  const { cwd, signal, emit } = run.ctx;
  return new Promise<RunResult>((resolve, reject) => {
    // Aborted while the factory got ready: that event has fired, so the listener below would never hear it.
    if (signal.aborted) return reject(cancelledRun(run.resume ?? null));
    const child = spawn(bin, run.args, { cwd, env: run.env, stdio: ["pipe", "pipe", "pipe"], detached: grouped });
    const untrack = trackGroup(child);
    const stopAborting = stopOnAbort(child, signal);
    const stopListening = () => {
      untrack();
      stopAborting();
    };

    child.stdin.on("error", () => {}); // it exited before reading the prompt; `close` reports why
    child.stdin.end(run.prompt);
    const stderr = keepTail(child.stderr);

    readMessages(
      child.stdout,
      (msg) => stream.handle(msg),
      (reason) => emit("note", `Skipped a message Crane couldn't read from ${label}: ${reason}`),
    );

    child.on("error", (err) => {
      stream.onProcessError?.();
      stopListening();
      reject(new Error(`Could not start ${label} (${bin}): ${err.message}`));
    });
    child.on("close", (code) => {
      stopListening();
      try {
        resolve(stream.finish({ code, stderr: stderr() }));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Continue the task's earlier session if it has one, or start a new one if that session is gone. */
export async function runResumingSession(
  ctx: Pick<RunContext, "resumeSession" | "signal" | "emit">,
  runOnce: (resume?: string) => Promise<RunResult>,
): Promise<RunResult> {
  if (!ctx.resumeSession) return runOnce();
  try {
    return await runOnce(ctx.resumeSession);
  } catch (err) {
    if (!(err instanceof SessionNotResumed) || ctx.signal.aborted) throw err;
    // Its history is gone, or the CLI won't load it. The worktree still has the work so far.
    ctx.emit("note", "Couldn't pick up the agent's earlier session, so it's starting a new one on the work so far");
    return runOnce();
  }
}
