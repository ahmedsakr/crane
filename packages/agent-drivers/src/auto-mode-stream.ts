import type { RunContext } from "@crane/agent-protocol";

/** How Claude Code starts the refusal it shows the model for a classifier block (docs/command-guard.md, question 13). */
export const CLASSIFIER_DENIAL = "Permission for this action was denied by the Claude Code auto mode classifier.";

/** Auto mode's pause after repeated blocks, from a `permission_denied` message (question 13). */
const PAUSE_TEXT = /actions were blocked/i;

export const AUTO_MODE_UNAVAILABLE = "Auto mode wasn't available for this run, so it ran with only allowed commands and Crane's guard.";
export const AUTO_MODE_PAUSED =
  "Claude Code's auto mode paused after repeated blocks and refused a command instead of reviewing it. The run continued; allowed commands and Crane's guard still apply.";

/** A call auto mode refused, as the stream should record it. */
export interface AutoModeBlock {
  toolUseId: string;
  tool: string | null;
  input: Record<string, unknown> | null;
  reason: string;
}

/** The classifier's reason from the text the model saw, such as `[Data Exfiltration]`. */
export function classifierReason(text: string): string {
  const after = text.slice(text.indexOf(CLASSIFIER_DENIAL) + CLASSIFIER_DENIAL.length);
  const match = /^\s*Reason:\s*(.+?)\.(?:\s|$)/s.exec(after);
  return (match?.[1] ?? text).trim();
}

/**
 * Watches an auto-mode run for what the operator should know: auto mode not
 * starting (the run then has only the allowlist and the guard), its pause
 * after repeated blocks, and the calls its classifier refused. Each note is
 * recorded once per run.
 */
export class AutoModeWatch {
  private unavailable = false;
  private paused = false;

  constructor(
    private requested: boolean,
    private emit: RunContext["emit"],
  ) {}

  /** `system/init` names the effective mode. When auto mode can't start, the run starts in `default` with no other sign. */
  onInit(msg: Record<string, any>) {
    if (!this.requested || this.unavailable || msg.permissionMode === "auto") return;
    this.unavailable = true;
    const mode = typeof msg.permissionMode === "string" ? msg.permissionMode : null;
    this.emit("note", AUTO_MODE_UNAVAILABLE, { permissionMode: mode, sessionId: msg.session_id ?? null });
  }

  /** A `system/permission_denied` event. Only the classifier's blocks and auto mode's pause are auto mode's to report. */
  onPermissionDenied(msg: Record<string, any>): AutoModeBlock | null {
    if (!this.requested || typeof msg.tool_use_id !== "string") return null;
    const message = typeof msg.message === "string" ? msg.message : "";
    const block = (reason: string): AutoModeBlock => ({
      toolUseId: msg.tool_use_id, tool: typeof msg.tool_name === "string" ? msg.tool_name : null,
      input: msg.tool_input && typeof msg.tool_input === "object" ? msg.tool_input : null, reason,
    });
    if (msg.decision_reason_type === "classifier") {
      const reason = typeof msg.decision_reason === "string" && msg.decision_reason.trim() ? msg.decision_reason.trim() : classifierReason(message);
      return block(reason);
    }
    if (!PAUSE_TEXT.test(message)) return null;
    if (!this.paused) {
      this.paused = true;
      this.emit("note", AUTO_MODE_PAUSED, { toolUseId: msg.tool_use_id });
    }
    return block(message.trim());
  }
}
