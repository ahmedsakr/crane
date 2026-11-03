import { errorMessage } from "@crane/contracts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** Long enough for a loaded machine, since "not available" fails the task that asked. */
const VERSION_CHECK_MS = 30_000;

/**
 * Whether an agent's CLI is installed and working: `<bin> --version` exits
 * cleanly. Callers wait on this with a crew slot held, and nothing else can
 * stop it, so a CLI that hangs counts as unavailable.
 */
export function cliAnswers(bin: string, timeoutMs = VERSION_CHECK_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, ["--version"], { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Hand each JSON object an agent's CLI prints to `onMessage`, skipping anything
 * else it prints. This runs in a stream listener, where a throw is uncaught and
 * ends the factory with every agent in it, so a message whose shape surprises
 * the handler costs that one message. `onUnreadable` hears only the first: when
 * a CLI's format changes, most of its messages may not parse.
 */
export function readMessages(
  input: Readable,
  onMessage: (msg: Record<string, any>) => void,
  onUnreadable: (reason: string) => void,
) {
  let told = false;
  createInterface({ input }).on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    try {
      onMessage(msg as Record<string, any>);
    } catch (err) {
      if (!told) onUnreadable(errorMessage(err));
      told = true;
    }
  });
}
