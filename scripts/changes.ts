import { spawnSync } from "node:child_process";

/**
 * Which files differ between a base commit and what a check will actually run on,
 * from local Git history only: nothing here fetches, and nothing guesses a base
 * such as HEAD~1. Every answer this can't stand behind becomes a reason for full
 * execution instead of a smaller, possibly empty, change set.
 */

export interface ChangeRequest {
  /** The known-good revision to compare with, such as `main` or a commit. Required. */
  base: string;
  /** Compare with this commit. It must be the checked-out commit, with no local changes. */
  head?: string;
  /** Compare with the files on disk: staged, unstaged and untracked (not ignored) changes. */
  workingTree: boolean;
}

export type ChangeSet =
  | { ok: true; paths: string[]; description: string }
  | { ok: false; reason: string; description?: string };

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type Git = (args: readonly string[]) => GitResult;

/** Git in `root`, with paths printed as-is and no pager. Output is bounded only by maxBuffer. */
export function gitIn(root: string): Git {
  return (args) => {
    const run = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
      cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_PAGER: "cat" },
    });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", error: run.error };
  };
}

class Unavailable extends Error {}

function git(run: Git, args: readonly string[], what: string): string {
  const result = run(args);
  if (result.error) throw new Unavailable(`Cannot run git to ${what}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n")[0] || `exit ${String(result.status)}`;
    throw new Unavailable(`Cannot ${what}: ${detail}`);
  }
  return result.stdout;
}

/** A revision as a full commit id, never treating it as an option. */
function commit(run: Git, revision: string, role: string): string {
  if (!revision || revision.startsWith("-")) throw new Unavailable(`The ${role} revision "${revision}" is not a revision`);
  const result = run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
  if (result.error || result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(result.stdout.trim())) {
    throw new Unavailable(`The ${role} revision "${revision}" is not a commit in this checkout's local history`);
  }
  return result.stdout.trim();
}

const nulList = (text: string) => text.split("\0").filter(Boolean);
const short = (id: string) => id.slice(0, 12);

/**
 * Paths changed since `request.base`. Renames count as both their old and new
 * paths, deletions and additions count, and working-tree mode adds untracked
 * files that aren't ignored. A tree comparison (not a merge-base one) lists every
 * file whose content differs from the base, including the base's newer changes
 * that the head lacks.
 */
export function changedPaths(run: Git, request: ChangeRequest): ChangeSet {
  let description: string | undefined;
  try {
    git(run, ["rev-parse", "--is-inside-work-tree"], "find a Git checkout");
    const base = commit(run, request.base, "base");
    const checkedOut = commit(run, "HEAD", "checked-out");
    const head = request.workingTree ? checkedOut : headCommit(run, request, checkedOut);
    description = request.workingTree
      ? `${request.base} (${short(base)}) → working tree at ${short(checkedOut)}`
      : `${request.base} (${short(base)}) → ${request.head} (${short(head)})`;
    if (!request.workingTree && head === base) {
      throw new Unavailable(`The head and base are both ${short(base)}, so a comparison would find nothing to check`);
    }
    const paths = request.workingTree ? workingTreePaths(run, base) : nulList(git(run, ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], "compare the base with the head"));
    if (!paths.length) throw new Unavailable(`Nothing differs from the base, so there is no change to select from`);
    return { ok: true, paths: [...new Set(paths)].sort(), description };
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    return { ok: false, reason: error.message, description };
  }
}

/** A head is only meaningful when it is exactly what's on disk: checks run on the checkout. */
function headCommit(run: Git, request: ChangeRequest, checkedOut: string): string {
  if (!request.head) throw new Unavailable("Name a head revision with --head, or compare with local files using --working-tree");
  const head = commit(run, request.head, "head");
  if (head !== checkedOut) {
    throw new Unavailable(`The checkout is at ${short(checkedOut)}, not the head ${request.head} (${short(head)}), and checks run on the checked-out files`);
  }
  const local = nulList(git(run, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "list local changes"));
  if (local.length) {
    throw new Unavailable(`The checkout has ${local.length} local change(s) that the head doesn't include; use --working-tree to count them`);
  }
  return head;
}

function workingTreePaths(run: Git, base: string): string[] {
  const tracked = nulList(git(run, ["diff", "--name-only", "--no-renames", "-z", base, "--"], "compare the base with the working tree"));
  const untracked = nulList(git(run, ["ls-files", "--others", "--exclude-standard", "-z"], "list untracked files"));
  return [...tracked, ...untracked];
}
