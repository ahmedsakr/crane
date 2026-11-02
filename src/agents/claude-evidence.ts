import { safeEvidenceText } from "../core/command-evidence.js";

/** Keep only textual diagnostics and known result metadata, never images or arbitrary SDK fields. */
export function claudeToolResult(block: Record<string, unknown>, metadata: unknown) {
  const result = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const exit = result.exit_code ?? result.exitCode;
  const content = typeof block.content === "string" ? block.content
    : Array.isArray(block.content) ? block.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("\n") : "";
  return {
    isError: typeof block.is_error === "boolean" ? block.is_error : null,
    exitCode: typeof exit === "number" && Number.isInteger(exit) ? exit : null,
    ...(typeof result.interrupted === "boolean" ? { interrupted: result.interrupted } : {}),
    content: safeEvidenceText(content, 8192),
    ...(typeof result.stdout === "string" ? { stdout: safeEvidenceText(result.stdout, 4096) } : {}),
    ...(typeof result.stderr === "string" ? { stderr: safeEvidenceText(result.stderr, 4096) } : {}),
  };
}
