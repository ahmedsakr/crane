import { spawn } from "node:child_process";

export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const INSTALL_PROGRESS_MS = 30 * 1000;
/** Shorter than the factory's own stop grace, so a stopping factory sees its installs end. */
export const INSTALL_STOP_GRACE_MS = 3 * 1000;

/** Keep complete lines until redaction; never retain an unbounded partial line. */
export class InstallDiagnostics {
  private pending = "";
  private dropping = false;
  private privateKey = false;
  private lines: string[] = [];
  private omitted = false;
  private bytes = 0;
  private lastOutput: number | null = null;

  push(chunk: string) {
    this.bytes += Buffer.byteLength(chunk);
    this.lastOutput = Date.now();
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!this.dropping) {
        if (this.pending.length + part.length > 8192) {
          this.pending = "";
          this.dropping = true;
          this.omitted = true;
        } else this.pending += part;
      }
      if (part.endsWith("\n")) this.flush();
    }
  }

  flush() {
    if (!this.dropping && this.pending.trim()) {
      // Treat terminal control sequences as untrusted output, too.
      let line = this.pending.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
      if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) this.privateKey = true;
      const hide = this.privateKey;
      if (/-----END .*PRIVATE KEY-----/.test(line)) this.privateKey = false;
      if (hide) line = "[REDACTED PRIVATE KEY]";
      // Redact before bounding each line, including quoted values and URL credentials.
      line = line
        .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
        .replace(/((?:https?|git\+https?):\/\/)[^\s/]*@/gi, "$1[REDACTED]@")
        .replace(/((?:https?|git\+https?):\/\/[^\s?#]+)[?#]\S*/gi, "$1?[REDACTED]")
        .replace(/\b([\w.-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|_auth|authorization|cookie)[\w.-]*["']?\s*(?:[:=]|\s)\s*).*/gi, "$1[REDACTED]");
      if (line.length > 512) this.omitted = true;
      this.lines.push(line.slice(0, 512));
      if (this.lines.length > 4) {
        this.lines.shift();
        this.omitted = true;
      }
    }
    this.pending = "";
    this.dropping = false;
  }

  snapshot(): string {
    const tail = `${this.omitted ? "[output truncated] " : ""}${this.lines.join(" | ")}` || "no complete output lines";
    const activity = this.lastOutput === null ? "no output received"
      : `${this.bytes} bytes received; last output ${Math.floor((Date.now() - this.lastOutput) / 1000)}s ago`;
    return `[${activity}] ${tail}`;
  }
}

/** Stream without execFile's raw output buffer or raw output in thrown errors. */
export async function runInstall(
  cmd: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; onProgress?: (note: string) => void },
  launch = spawn,
  killGroup = process.kill,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const started = Date.now();
  const command = [cmd, ...args].join(" ");
  const stdout = new InstallDiagnostics();
  const stderr = new InstallDiagnostics();
  const diagnostics = () => `stdout: ${stdout.snapshot()}\nstderr: ${stderr.snapshot()}`;
  const duration = () => `${Math.floor((Date.now() - started) / 1000)}s`;
  // Its own process group: `close` waits for every process holding the pipes, so
  // stopping only npm would leave this waiting on whatever its scripts started.
  const grouped = process.platform !== "win32";
  const child = launch(cmd, args, { cwd: opts.cwd, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: string) => stderr.push(chunk));
  let timedOut = false;
  let processError: string | undefined;
  const send = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) killGroup(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  let forced: NodeJS.Timeout | undefined;
  const stop = () => {
    if (forced) return;
    send("SIGTERM");
    forced = setTimeout(() => {
      send("SIGKILL");
      // Something that left the group may still hold the pipes.
      child.stdout!.destroy();
      child.stderr!.destroy();
    }, INSTALL_STOP_GRACE_MS);
  };
  opts.signal?.addEventListener("abort", stop, { once: true });
  const heartbeat = setInterval(() => {
    opts.onProgress?.(`Installing dependencies (${command}): still running after ${duration()} (limit 600s)\n${diagnostics()}`);
  }, INSTALL_PROGRESS_MS);
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, INSTALL_TIMEOUT_MS);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      // A failed spawn still closes; wait for streams to drain and cleanup.
      child.on("error", (err: NodeJS.ErrnoException) => { processError = err.code ?? "spawn error"; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    stdout.flush();
    stderr.flush();
    const outcome = opts.signal?.aborted ? "cancelled"
      : timedOut ? "timed out (600s limit)"
      : processError ? `could not run (${processError})`
      : result.code === 0 ? "completed (exit 0)"
      : `failed (exit ${result.code ?? "unknown"}, signal ${result.signal ?? "none"})`;
    const note = `Dependency install (${command}) ${outcome} after ${duration()}\n${diagnostics()}`;
    opts.onProgress?.(note);
    if (opts.signal?.aborted || timedOut || processError || result.code !== 0) {
      const err = new Error(note);
      if (opts.signal?.aborted) err.name = "AbortError";
      throw err;
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    clearTimeout(forced);
    opts.signal?.removeEventListener("abort", stop);
  }
}
