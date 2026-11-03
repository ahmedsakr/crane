import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Callers can't cancel these, so a git command that hangs would hold its crew
 * slot past the task's time limit. Generous, since a commit runs the repo's own hooks.
 */
const GIT_TIMEOUT_MS = 10 * 60_000;

/** Run git in `cwd` and return its trimmed stdout. Knows nothing about Crane's worktrees or branches. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}
