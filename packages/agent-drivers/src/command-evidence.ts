import { randomUUID } from "node:crypto";
import type { CommandEvidence } from "@crane/contracts";

const COMMAND_LIMIT = 8192;

/** Best-effort credential redaction before truncation, shared by commands and diagnostics. */
export function safeEvidenceText(raw: string, limit = COMMAND_LIMIT): { text: string; truncated: boolean } {
  const value = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;&|"'\\])+`;
  const sensitive = String.raw`[\w.-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|authorization|cookie)[\w.-]*`;
  const redacted = raw
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/(['"])(?:Authorization|Cookie|Set-Cookie)\s*:[\s\S]*?\1/gi, "'[REDACTED HEADER]'")
    .replace(new RegExp(String.raw`((?:--user|-u)\s+)${value}`, "g"), "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 [REDACTED]")
    .replace(new RegExp(String.raw`\b((?:--?)?${sensitive}["']?\s*(?:=|:|\s)\s*)${value}`, "gi"), "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s'"?]+)\?[^\s'"]+/gi, "$1?[REDACTED]");
  return { text: redacted.slice(0, limit), truncated: redacted.length > limit };
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
