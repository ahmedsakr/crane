import { safeEvidenceText } from "./command-evidence.js";
import type { CommandEvidence } from "@crane/contracts";

/** Keep only textual diagnostics and known result metadata, never images or arbitrary SDK fields. */
export function claudeToolResult(block: Record<string, unknown>, metadata: unknown) {
  const result = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  // SDKUserMessage.tool_use_result is unknown. The documented BashOutput has
  // stdout/stderr/interrupted, but no exit code. Accept explicit numeric aliases
  // when supplied; tool success and output (including TAP) cannot supply a code.
  const exit = result.exit_code ?? result.exitCode;
  const exitCode = typeof exit === "number" && Number.isSafeInteger(exit) ? exit : null;
  const content = toolResultText(block.content);
  return {
    isError: typeof block.is_error === "boolean" ? block.is_error : null,
    exitCode,
    exitCodeSource: exitCodeSource(exitCode, result),
    ...(typeof result.interrupted === "boolean" ? { interrupted: result.interrupted } : {}),
    content: safeEvidenceText(content, 8192),
    ...(typeof result.stdout === "string" ? { stdout: safeEvidenceText(result.stdout, 4096) } : {}),
    ...(typeof result.stderr === "string" ? { stderr: safeEvidenceText(result.stderr, 4096) } : {}),
  };
}

/** A tool result's text: the string itself, or its text parts joined by newlines. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

/** Which metadata field supplied the exit code, preferring `exit_code` as the lookup does. */
function exitCodeSource(exitCode: number | null, result: Record<string, unknown>): "exit_code" | "exitCode" | null {
  if (exitCode === null) return null;
  return result.exit_code != null ? "exit_code" : "exitCode";
}

/** Driver-owned qualification of agent validation claims, separate from external checks. */
export function claudeValidationSummary(commands: readonly CommandEvidence[]): string {
  const missing = commands.filter(command => command.exitCode === null);
  if (!missing.length) return "";
  const examples = missing.slice(0, 5).map(command =>
    JSON.stringify(safeEvidenceText(command.command, 240).text)).join(", ");
  return `Claude command validation evidence: ${missing.length} Bash command(s) have no recorded process exit code in this invocation (${examples}${missing.length > 5 ? ", …" : ""}). Their process outcomes are unconfirmed; tool success and passing output counts do not establish exit 0. Crane's external review and merge checks are separate evidence.`;
}
