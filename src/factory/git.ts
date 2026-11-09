import { errorMessage } from "@crane/contracts";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { git } from "@crane/backend-runtime";
import { worktreesDir } from "@crane/backend-runtime";
import { slugify } from "@crane/backend-runtime";
import type { LandedCommit } from "../core/store.js";
import { fetchDefault } from "./merge-fetch.js";
import { newestDefault, remoteFor, why } from "./merge-git.js";
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

/** Crane stopped before dependency setup or the agent, and the operator has something to fix. */
export class PreparationHold extends Error {}

/**
 * Hold unless `target` contains every required commit. A commit git can't find
 * counts as missing: nothing here can show that it's there.
 */
export async function requireCommits(cwd: string, target: string, required: readonly LandedCommit[], where: string, next: string): Promise<void> {
  const missing: LandedCommit[] = [];
  for (const c of required) {
    if (!(await succeeds(cwd, "merge-base", "--is-ancestor", c.commit, target))) missing.push(c);
  }
  if (!missing.length) return;
  const list = missing.map((c) => `${c.id} "${c.title}" (${c.commit.slice(0, 8)})`).join(", ");
  throw new PreparationHold(`${where} doesn't contain landed prerequisite ${list}. ${next}`);
}

export interface WorktreeOptions {
  /** Commits the worktree must contain before anything runs in it. */
  required?: readonly LandedCommit[];
  signal?: AbortSignal;
  note?: (message: string) => void;
}

/**
 * The commit a new worktree starts from: the newest of the local and remote
 * default branch, by the merge path's rules. Never moves either of them, so an
 * operator checkout left behind stays exactly as it is. A failed fetch isn't a
 * hold on its own, since the refs already here may be enough.
 */
async function worktreeBase(repo: Repo, opts: WorktreeOptions): Promise<{ sha: string; label: string }> {
  const main = repo.defaultBranch;
  const remote = await remoteFor(repo);
  if (remote) {
    try {
      await fetchDefault(repo, remote, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      opts.note?.(`Couldn't fetch ${main} from ${remote}: ${why(err)}. Starting from the commits Crane already has`);
    }
  }
  const tip = await newestDefault(repo, remote);
  if (tip === "diverged") {
    throw new PreparationHold(`Your local ${main} and ${remote}/${main} have diverged, so Crane can't choose a commit to start from. Bring them back together (git pull), then retry this task.`);
  }
  if (!tip) return { sha: "HEAD", label: "HEAD" };
  if (tip.localBehind) opts.note?.(`Starting from ${tip.label}, because your local ${main} is behind it. Crane didn't change your ${main} or its checkout`);
  return tip;
}

/**
 * Give a task its own branch and working directory so agents never touch the
 * operator's checkout. A worktree that already exists keeps its work untouched;
 * it's only checked. Holds, creating nothing new, if a required commit is missing.
 */
export async function createWorktree(repo: Repo, task: Task, opts: WorktreeOptions = {}): Promise<{ branch: string; path: string; base?: string }> {
  const branch = branchFor(task);
  const path = join(worktreesDir(), task.id);
  const required = opts.required ?? [];
  if (existsSync(path)) {
    await requireCommits(path, "HEAD", required, `This task's worktree at ${path}`, `Crane didn't start the agent, and saves the task's work to ${branch}. Retry this task to start from the newest ${repo.defaultBranch}.`);
    return { branch, path };
  }
  const base = await worktreeBase(repo, opts);
  await requireCommits(repo.path, base.sha, required, base.label, `Crane didn't start the agent. Bring ${repo.defaultBranch} up to date, then retry this task.`);
  await git(repo.path, "worktree", "add", "-b", branch, path, base.sha);
  return { branch, path, base: await git(path, "rev-parse", "HEAD") };
}

/**
 * What a task's branch is compared with: the newest default branch, so commits it
 * started from aren't mistaken for its own when the local default branch is behind.
 * Null when the repo has no default branch.
 */
export async function comparisonBase(repo: Repo): Promise<string | null> {
  const tip = await newestDefault(repo, await remoteFor(repo));
  return tip === "diverged" ? `refs/heads/${repo.defaultBranch}` : (tip?.sha ?? null);
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
  const base = await comparisonBase(repo);
  if (!base) return [];
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
    return { diff: await git(repo.path, "diff", `${(await comparisonBase(repo)) ?? repo.defaultBranch}...${task.branch}`), live: false };
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
  const base = await read("merge-base", (await comparisonBase(repo)) ?? repo.defaultBranch, "HEAD").catch(() => "HEAD");
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
      return { removed: false, reason: `couldn't commit its changes: ${errorMessage(err).split("\n")[0]}` };
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
