import { randomUUID } from "node:crypto";
import type { CommandEvidence } from "@crane/contracts";
import { sanitizeDiagnosticText } from "@crane/diagnostics";

const COMMAND_LIMIT = 8192;

/** Commands and tool diagnostics, sanitized before they're stored or shown. */
export function safeEvidenceText(raw: string, limit = COMMAND_LIMIT): { text: string; truncated: boolean } {
  return sanitizeDiagnosticText(raw, limit);
}

export function safeCommand(raw: string): Pick<CommandEvidence, "command" | "truncated"> {
  const { text, truncated } = safeEvidenceText(raw);
  return { command: text, truncated };
}

/** One CLI invocation; item IDs alone can repeat in later sessions/runs. */
export class CommandTracker {
  private invocation = randomUUID();
  private pending = new Map<string, CommandEvidence>();

  constructor(private emit: (evidence: CommandEvidence) => void) {}

  record(phase: "started" | "completed", item: Record<string, unknown>, command: string, sessionId: string | null) {
    const itemId = typeof item.id === "string" ? item.id : null;
    const commandId = `${this.invocation}:${itemId ?? randomUUID()}`;
    const previous = this.pending.get(commandId);
    const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : null;
    const status = phase === "started" ? "running"
      : item.status === "interrupted" ? "interrupted"
      : item.status === "failed" || (exitCode !== null && exitCode !== 0) ? "failed"
      : item.status === "completed" && exitCode === 0 ? "completed" : "unknown";
    const evidence: CommandEvidence = {
      commandId, itemId, sessionId,
      ...(previous && !command ? { command: previous.command, truncated: previous.truncated } : safeCommand(command)),
      status, exitCode: phase === "started" ? null : exitCode,
    };
    if (phase === "started") this.pending.set(commandId, evidence);
    else this.pending.delete(commandId);
    this.emit(evidence);
  }

  close(interrupted: boolean) {
    for (const evidence of this.pending.values()) {
      this.emit({ ...evidence, status: interrupted ? "interrupted" : "unknown", exitCode: null });
    }
    this.pending.clear();
  }
}
