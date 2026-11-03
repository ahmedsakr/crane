/**
 * Minimal SDK user-result fixtures. BashOutput's documented fields do not include
 * an exit code: https://code.claude.com/docs/en/agent-sdk/typescript#tool-output-types
 * Explicit exit aliases cover CLI variants already supported by Crane, rather
 * than promising that the SDK supplies them.
 */
export const claudeResultShapes = [
  {
    name: "documented BashOutput with passing TAP",
    block: { is_error: false, content: "# tests 12\n# pass 12\n# fail 0" },
    metadata: { stdout: "# tests 12\n# pass 12\n# fail 0", stderr: "", interrupted: false },
    exitCode: null, source: null, status: "unknown",
  },
  {
    name: "explicit snake-case success",
    block: { is_error: false, content: "ok" },
    metadata: { exit_code: 0, stdout: "ok", stderr: "", interrupted: false },
    exitCode: 0, source: "exit_code", status: "completed",
  },
  {
    name: "explicit camel-case failure despite tool success",
    block: { is_error: false, content: "# pass 12" },
    metadata: { exitCode: 2 },
    exitCode: 2, source: "exitCode", status: "failed",
  },
  {
    name: "error text is diagnostic evidence only",
    block: { is_error: true, content: "Exit code 2" },
    metadata: { stdout: "", stderr: "Exit code 2", interrupted: false },
    exitCode: null, source: null, status: "failed",
  },
  {
    name: "background result has no process verdict",
    block: { is_error: false, content: "Running in background" },
    metadata: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "task-1" },
    exitCode: null, source: null, status: "unknown",
  },
  {
    name: "interrupted without an exit",
    block: { is_error: true, content: "Interrupted" },
    metadata: { stdout: "", stderr: "", interrupted: true },
    exitCode: null, source: null, status: "interrupted",
  },
] as const;
