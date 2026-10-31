import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreesDir } from "../core/paths.js";
import { slugify } from "../core/ids.js";
import type { Task, Repo } from "../core/types.js";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch {
    return false;
  }
}

export async function repoRoot(path: string): Promise<string> {
  return git(path, "rev-parse", "--show-toplevel");
}

export async function currentBranch(path: string): Promise<string> {
  try {
    const ref = await git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return ref.replace(/^origin\//, "");
  } catch {
    try {
      return (await git(path, "rev-parse", "--abbrev-ref", "HEAD")) || "main";
    } catch {
      return "main";
    }
  }
}

export function branchFor(task: Task): string {
  return `crane/${slugify(task.title, 32)}-${task.id.slice(2)}`;
}

/** Give a task its own branch and working directory so agents never touch the operator's checkout. */
export async function createWorktree(repo: Repo, task: Task): Promise<{ branch: string; path: string }> {
  const branch = branchFor(task);
  const path = join(worktreesDir(), task.id);
  if (!existsSync(path)) {
    let base = repo.defaultBranch;
    try {
      await git(repo.path, "rev-parse", "--verify", base);
    } catch {
      base = "HEAD";
    }
    await git(repo.path, "worktree", "add", "-b", branch, path, base);
  }
  return { branch, path };
}

/** Commit anything the agent left uncommitted, then list what changed on the branch. */
export async function finalizeWorktree(repo: Repo, task: Task, path: string): Promise<string[]> {
  const dirty = await git(path, "status", "--porcelain");
  if (dirty) {
    await git(path, "add", "-A");
    await git(
      path,
      "-c",
      "user.name=Crane",
      "-c",
      "user.email=crane@localhost",
      "commit",
      "-m",
      `crane: ${task.title}\n\nTask ${task.id}`,
    );
  }
  let base = repo.defaultBranch;
  try {
    await git(path, "rev-parse", "--verify", base);
  } catch {
    return [];
  }
  const out = await git(path, "diff", "--name-only", `${base}...HEAD`);
  return out ? out.split("\n") : [];
}

export async function diffForTask(repo: Repo, task: Task): Promise<string> {
  if (!task.branch) return "";
  try {
    return await git(repo.path, "diff", `${repo.defaultBranch}...${task.branch}`);
  } catch {
    return "";
  }
}

export async function removeWorktree(repo: Repo, path: string, opts: { deleteBranch?: string } = {}) {
  try {
    await git(repo.path, "worktree", "remove", "--force", path);
  } catch {
    // already gone
  }
  if (opts.deleteBranch) {
    try {
      await git(repo.path, "branch", "-D", opts.deleteBranch);
    } catch {
      // already gone
    }
  }
}
