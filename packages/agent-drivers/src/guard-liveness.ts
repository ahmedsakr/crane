import type { RunContext } from "@crane/agent-protocol";
import { GUARD_LIVENESS } from "./command-guard-protocol.js";

/**
 * Checks that Crane's command guard answered for every Bash call. Claude Code
 * treats a hook that crashed, timed out or never started as no decision, which
 * leaves the call to the allowlist alone: refused if it isn't listed, run
 * unchecked if it is. Hook events carry no tool-use id, so the hook names the
 * call in its stderr line, which arrives in `hook_response` before the call runs.
 */
export class GuardLiveness {
  private answered = new Set<string>();
  private missed = false;

  /** `autoMode`: the run asked for Claude Code's auto mode, whose classifier also decides calls the guard missed. */
  constructor(
    private installed: boolean,
    private emit: RunContext["emit"],
    private autoMode = false,
  ) {}

  onHookResponse(msg: Record<string, any>) {
    if (!this.installed || msg.hook_event !== "PreToolUse" || typeof msg.stderr !== "string") return;
    for (const match of msg.stderr.matchAll(GUARD_LIVENESS)) this.answered.add(match[1]!);
  }

  /** A Bash call's result arrived. One note per run is enough to send the operator looking. */
  onBashResult(toolUseId: string) {
    if (!this.installed || this.answered.has(toolUseId) || this.missed) return;
    this.missed = true;
    const decided = this.autoMode ? "only the allowlist and Claude Code's auto mode decided it" : "only the allowlist decided it";
    this.emit("note", `Crane's command guard didn't answer for a command, so ${decided}. Check that the factory's packages are built (npm run build:packages) and that the hook can start.`, {
      toolUseId,
    });
  }
}
