import { isAbsolute } from "node:path";

/**
 * The factory CLI's read-only commands that agents may run to investigate
 * tasks: `tasks` lists them, `show` prints one with its report, runs and
 * activity log. Everything else on the CLI changes state or never exits
 * (`watch`), and Crane's command guard refuses state changes regardless.
 */
export const TASK_LOG_COMMANDS = ["tasks", "show"] as const;

// Claude Code matches allow rules against the command text, so the path is
// written unquoted and must not need quoting.
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** Shell words that start the factory's CLI, or null when there is no usable path. */
export function craneCliCommand(path: string | undefined): string | null {
  if (!path || !isAbsolute(path) || !SHELL_SAFE.test(path)) return null;
  return `node ${path}`;
}

/** Narrow allow rules for the read-only commands, never `Bash(node:*)`. */
export function craneCliRules(command: string | null): string[] {
  return command ? TASK_LOG_COMMANDS.map((name) => `Bash(${command} ${name}:*)`) : [];
}

/** How an agent reads Crane's own task records and logs. */
export function craneCliBrief(command: string | null | undefined): string {
  if (!command) return "";
  return [
    `To investigate Crane's own tasks, such as an earlier task's activity log, use the running factory's CLI with its read-only commands. \`${command} tasks --all --json\` lists tasks with their status, branch and worktree (add \`-n 500\` for more than 50). \`${command} show <id> --events\` prints a task's report, runs, blocked commands and full activity log, including every tool call, and \`${command} show <id> --json\` prints the same records as JSON.`,
    "Only `tasks` and `show` are allowed; commands that change Crane's state belong to the operator and are refused. Use this CLI rather than `npm run crane` from a checkout, and don't open Crane's database directly.",
  ].join(" ");
}
