import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { git } from "../core/git.js";
import { worktreesDir } from "../core/paths.js";
import { slugify } from "../core/ids.js";
import type { Task, Repo, TaskDiff } from "@crane/contracts";

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

/** Infer the default branch from origin/HEAD, then the checked-out branch, then main. */
export async function inferDefaultBranch(path: string): Promise<string> {
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

/**
 * What the task changed. While it runs, that's its worktree as it stands, uncommitted
 * work included, so the operator can follow along. Once merged, it's what the merge
 * commit brought in, since the branch itself may be gone. Otherwise it's the branch.
 */
export async function diffForTask(repo: Repo, task: Task, mergeCommit?: string | null): Promise<TaskDiff> {
  if (task.status === "running" && task.worktree && insideWorktrees(task.worktree) && existsSync(task.worktree)) {
    try {
      return { diff: await worktreeDiff(repo, task.worktree), live: true };
    } catch {
      // Fall back to what's committed on the branch.
    }
  }
  try {
    if (mergeCommit) return { diff: await git(repo.path, "diff", `${mergeCommit}^1`, mergeCommit), live: false };
    if (!task.branch) return { diff: "", live: false };
    return { diff: await git(repo.path, "diff", `${repo.defaultBranch}...${task.branch}`), live: false };
  } catch {
    return { diff: "", live: false };
  }
}

/** New files past this many are counted, not shown, so a stray build folder can't flood the page. */
export const MAX_NEW_FILES = 100;

/**
 * Everything a worktree changed since it left the default branch: its commits, its
 * uncommitted edits, and files it created but hasn't added. Read-only, and it never takes
 * git's index lock, so it can't trip up an agent committing in the same worktree.
 */
async function worktreeDiff(repo: Repo, path: string): Promise<string> {
  const read = (...args: string[]) => git(path, "--no-optional-locks", ...args);
  const base = await read("merge-base", repo.defaultBranch, "HEAD").catch(() => "HEAD");
  const parts = [await read("diff", base)];
  const added = (await read("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  for (const file of added.slice(0, MAX_NEW_FILES)) {
    // Exit code 1 is how `diff --no-index` says the files differ, which they always do here.
    const out = await read("diff", "--no-index", "--", "/dev/null", file).catch((err: { code?: number; stdout?: string }) =>
      err.code === 1 && typeof err.stdout === "string" ? err.stdout.trim() : "",
    );
    parts.push(out);
  }
  if (added.length > MAX_NEW_FILES) parts.push(`${added.length - MAX_NEW_FILES} more new files not shown`);
  return parts.filter(Boolean).join("\n");
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether `path` is inside Crane's worktrees folder, and so never the operator's checkout. */
function insideWorktrees(path: string): boolean {
  const rel = relative(real(worktreesDir()), real(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Whether git lists `path` as one of `repo`'s worktrees. */
async function isWorktreeOf(repo: Repo, path: string): Promise<boolean> {
  const want = real(path);
  const out = await git(repo.path, "worktree", "list", "--porcelain");
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .some((l) => real(l.slice("worktree ".length)) === want);
}

const succeeds = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

export type PutAway = { removed: true; saved: boolean } | { removed: false; reason: string };

/**
 * Remove a finished task's worktree. With `saveWork`, anything the agent left
 * uncommitted is first committed to the task's branch, so the branch keeps the
 * work and only the directory goes. A worktree whose work can't be saved
 * safely (off its branch, mid-merge, or the commit fails) is left alone, and
 * so is anything outside Crane's worktrees folder, such as the operator's checkout.
 */
export async function putAwayWorktree(repo: Repo, task: Task, path: string, opts: { saveWork: boolean }): Promise<PutAway> {
  if (!insideWorktrees(path)) return { removed: false, reason: "it isn't in Crane's worktrees folder" };
  if (!existsSync(path)) {
    await succeeds(repo.path, "worktree", "prune");
    return { removed: true, saved: false };
  }
  if (!(await isWorktreeOf(repo, path))) return { removed: false, reason: `git doesn't list it as a worktree of ${repo.name}` };

  let saved = false;
  if (opts.saveWork && (await git(path, "status", "--porcelain"))) {
    const head = await git(path, "symbolic-ref", "-q", "--short", "HEAD").catch(() => "");
    if (!task.branch || head !== task.branch) {
      return { removed: false, reason: `it has uncommitted changes and isn't on ${task.branch ?? "a task branch"}` };
    }
    for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (await succeeds(path, "rev-parse", "-q", "--verify", ref)) {
        return { removed: false, reason: "it has uncommitted changes in the middle of a merge" };
      }
    }
    try {
      await git(path, "add", "-A");
      const why = task.status === "cancelled" ? "was cancelled" : "failed";
      await git(
        path,
        "-c",
        "user.name=Crane",
        "-c",
        "user.email=crane@localhost",
        "commit",
        "-m",
        `crane: unfinished work on ${task.title}\n\nTask ${task.id}. Saved by Crane when the task ${why}.`,
      );
    } catch (err) {
      return { removed: false, reason: `couldn't commit its changes: ${(err as Error).message.split("\n")[0]}` };
    }
    saved = true;
  }

  await removeWorktree(repo, path);
  if (existsSync(path)) return { removed: false, reason: "git couldn't remove it" };
  return { removed: true, saved };
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
