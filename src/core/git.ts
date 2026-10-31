import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Run git in `cwd` and return its trimmed stdout. Knows nothing about Crane's worktrees or branches. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
