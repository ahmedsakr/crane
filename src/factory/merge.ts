import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventType, Repo, Task } from "@crane/contracts";
import { runChecks } from "./checks.js";
import { installDependencies } from "./deps.js";
import type { ValidationRun } from "@crane/contracts";

const run = promisify(execFile);

/**
 * Landing an approved task on the default branch.
 *
 * Crane's own code does every git step here; agents never do. Only conflict
 * resolution goes to an agent, which edits files inside Crane's worktree and
 * nothing else. The shape is the one an operator would do by hand:
 *
 *   1. Fetch the default branch and take the newest of local and remote.
 *   2. In Crane's worktree, detach at that commit and `merge --no-ff` the task
 *      branch, so the default branch gets one "Merge branch 'crane/…'" commit.
 *   3. If that conflicts, hand the conflicted files to `resolveConflicts`, check
 *      no markers are left, and commit.
 *   4. Push the merge commit to the remote as a plain fast-forward. Crane never
 *      force-pushes; if the remote moved meanwhile, start again from 1.
 *   5. Move the local default branch forward. A checkout of it is only touched
 *      when it has no local changes, using `merge --ff-only`, so git itself
 *      refuses anything that would lose work. Otherwise it's left for the
 *      operator to pull.
 *
 * Every step is safe to repeat, so a factory restart mid-merge just runs it again.
 */

export class MergeError extends Error {}

export interface MergeRequest {
  checks?: string[];
  recordValidation?: (run: ValidationRun) => void;
  repo: Repo;
  task: Task;
  /** Crane's directory for building the merge. Never the operator's checkout. */
  workdir: string;
  emit: (type: EventType, message: string, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /**
   * Called while a merge is stopped on conflicts in `cwd`. Should leave every
   * file resolved (markers removed); staging and committing is optional.
   */
  resolveConflicts: (ctx: { cwd: string; base: string; files: string[] }) => Promise<void>;
  /** How many times to start over when the remote moves under us. */
  maxAttempts?: number;
}

export interface MergeResult {
  /** The merge commit Crane made, or null if the branch was already in the default branch. */
  commit: string | null;
  /** Where the default branch now points. */
  head: string;
  pushedTo: string | null;
  /** A checkout of the default branch that was left behind because it had local changes. */
  checkoutBehind: string | null;
}

// ── git plumbing ────────────────────────────────────────────

/** Network calls must never sit waiting on a password prompt nobody will answer. */
const NET_ENV = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
});

async function g(cwd: string, args: string[], opts: { net?: boolean } = {}): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: opts.net ? NET_ENV() : process.env,
    timeout: opts.net ? 2 * 60_000 : 60_000,
  });
  return stdout.trim();
}

async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await g(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** The useful line out of a failed git call, for the operator. */
function why(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || e.message || String(err);
  const lines = text.split("\n").map((l) => l.replace(/^(fatal|error|hint):\s*/, "").trim());
  return lines.find((l) => l && !l.startsWith("Command failed")) ?? "git failed";
}

const revParse = async (cwd: string, ref: string) => {
  try {
    return await g(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  } catch {
    return null;
  }
};

const isAncestor = (cwd: string, a: string, b: string) => succeeds(cwd, ["merge-base", "--is-ancestor", a, b]);

/** Use the operator's git identity when they have one, Crane's otherwise. */
async function identity(cwd: string): Promise<string[]> {
  return (await succeeds(cwd, ["config", "user.email"])) ? [] : ["-c", "user.name=Crane", "-c", "user.email=crane@localhost"];
}

/** The remote the default branch tracks, or `origin`, or none. */
export async function remoteFor(repo: Repo): Promise<string | null> {
  try {
    const tracked = await g(repo.path, ["config", "--get", `branch.${repo.defaultBranch}.remote`]);
    if (tracked && tracked !== ".") return tracked;
  } catch {
    // not configured
  }
  const remotes = (await g(repo.path, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : null;
}

/** Where a branch is checked out, if anywhere. */
export async function checkoutOf(repo: Repo, branch: string): Promise<string | null> {
  const out = await g(repo.path, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// ── steps ───────────────────────────────────────────────────

async function prepareWorkdir(repo: Repo, workdir: string, branch: string) {
  if (existsSync(workdir) && (await succeeds(workdir, ["rev-parse", "--git-dir"]))) {
    // A previous attempt may have stopped mid-merge.
    if (await revParse(workdir, "MERGE_HEAD")) await g(workdir, ["merge", "--abort"]);
    if (await g(workdir, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new MergeError(`Crane's worktree at ${workdir} has uncommitted changes, so it wasn't merged`);
    }
    return;
  }
  await succeeds(repo.path, ["worktree", "prune"]);
  await g(repo.path, ["worktree", "add", "--detach", workdir, branch]);
}

/** The commit to merge onto: the newest of the local and remote default branch. */
async function resolveBase(
  repo: Repo,
  remote: string | null,
  emit: MergeRequest["emit"],
): Promise<{ sha: string; label: string }> {
  const main = repo.defaultBranch;
  const local = await revParse(repo.path, `refs/heads/${main}`);
  let upstream: string | null = null;
  if (remote) {
    try {
      await g(repo.path, ["fetch", "--quiet", remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], { net: true });
    } catch (err) {
      throw new MergeError(`Couldn't fetch ${main} from ${remote}: ${why(err)}`);
    }
    upstream = await revParse(repo.path, `refs/remotes/${remote}/${main}`);
  }
  if (!local && !upstream) throw new MergeError(`There's no ${main} branch to merge into`);
  if (!upstream) return { sha: local!, label: main };
  if (!local || local === upstream || (await isAncestor(repo.path, local, upstream))) {
    return { sha: upstream, label: `${remote}/${main}` };
  }
  if (await isAncestor(repo.path, upstream, local)) {
    const ahead = await g(repo.path, ["rev-list", "--count", `${upstream}..${local}`]);
    emit("note", `Your local ${main} has ${ahead} commit${ahead === "1" ? "" : "s"} not on ${remote} yet. They'll be pushed too.`);
    return { sha: local, label: main };
  }
  throw new MergeError(
    `Your local ${main} and ${remote}/${main} have diverged. Bring them back together (git pull), then merge again.`,
  );
}

const MARKER = /^(<{7}|>{7})(\s|$)/m;

/** Files from the conflict list that still contain conflict markers. */
export async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const f of files) {
    const p = join(cwd, f);
    if (existsSync(p) && MARKER.test(await readFile(p, "utf8").catch(() => ""))) left.push(f);
  }
  return left;
}

/** Build the merge commit on top of `base` in the workdir. Returns its sha. */
async function buildMerge(req: MergeRequest, base: { sha: string; label: string }): Promise<string> {
  const { workdir: cwd, task, emit } = req;
  const branch = task.branch!;
  const branchSha = (await revParse(cwd, `refs/heads/${branch}`))!;
  await g(cwd, ["checkout", "--quiet", "--detach", base.sha]);
  const message = `Merge branch '${branch}'\n\nTask ${task.id}: ${task.title}`;
  const id = await identity(cwd);
  try {
    await g(cwd, [...id, "merge", "--no-ff", "--no-edit", "-m", message, branch]);
    return await g(cwd, ["rev-parse", "HEAD"]);
  } catch (err) {
    const files = (await g(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    if (!files.length) {
      await succeeds(cwd, ["merge", "--abort"]);
      throw new MergeError(`git couldn't merge ${branch}: ${why(err)}`);
    }
    emit(
      "note",
      `${files.length} file${files.length === 1 ? "" : "s"} conflict with ${base.label}: ${files.slice(0, 5).join(", ")}${
        files.length > 5 ? ", …" : ""
      }. Asking an agent to resolve ${files.length === 1 ? "it" : "them"}.`,
      { conflicts: files },
    );
    try {
      try {
        await prepareDependencies(req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        // Conflicted manifests may not be installable until the agent resolves them.
        emit("note", `Couldn't prepare dependencies before conflict resolution: ${why(err)}. Will retry before merge checks.`);
      }
      await req.resolveConflicts({ cwd, base: base.label, files });
    } catch (resolveErr) {
      await succeeds(cwd, ["merge", "--abort"]);
      throw resolveErr;
    }

    const left = await filesWithMarkers(cwd, files);
    if (left.length) {
      await succeeds(cwd, ["merge", "--abort"]);
      throw new MergeError(`Conflicts are still unresolved in ${left.join(", ")}`);
    }
    await g(cwd, ["add", "-A"]);
    const unmerged = (await g(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    if (unmerged.length) {
      await succeeds(cwd, ["merge", "--abort"]);
      throw new MergeError(`Conflicts are still unresolved in ${unmerged.join(", ")}`);
    }
    // The agent may have committed the merge itself; either way is fine.
    if (await revParse(cwd, "MERGE_HEAD")) await g(cwd, [...id, "commit", "--no-edit", "--quiet"]);
    const head = await g(cwd, ["rev-parse", "HEAD"]);
    if (!(await isAncestor(cwd, branchSha, head)) || !(await isAncestor(cwd, base.sha, head))) {
      throw new MergeError("The resolved merge doesn't contain both the task and the default branch");
    }
    emit("note", `Resolved the conflicts with ${base.label}`);
    return head;
  }
}

async function prepareDependencies(req: MergeRequest): Promise<void> {
  const note = await installDependencies(req.workdir, { from: req.repo.path, signal: req.signal });
  if (note) req.emit("note", note);
}

async function push(repo: Repo, remote: string, commit: string): Promise<"ok" | "moved"> {
  try {
    await g(repo.path, ["push", "--porcelain", remote, `${commit}:refs/heads/${repo.defaultBranch}`], { net: true });
    return "ok";
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    if (/\[rejected\]|non-fast-forward|fetch first|stale info/.test(`${e.stdout ?? ""}\n${e.stderr ?? ""}`)) return "moved";
    throw new MergeError(`Couldn't push to ${remote}: ${why(err)}`);
  }
}

/** Move the local default branch to `commit`. Returns a checkout that was left behind, if any. */
async function moveLocalDefault(repo: Repo, workdir: string, commit: string): Promise<string | null> {
  const main = repo.defaultBranch;
  const local = await revParse(repo.path, `refs/heads/${main}`);
  if (local === commit) return null;
  const at = await checkoutOf(repo, main);
  if (at) {
    // Someone's checkout. Only fast-forward it when nothing there could be in the way.
    const dirty = await g(at, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "?");
    if (dirty) return at;
    return (await succeeds(at, ["merge", "--ff-only", "--quiet", commit])) ? null : at;
  }
  if (!local) return null;
  // Not checked out anywhere. `fetch .` only fast-forwards, and refuses if a
  // worktree is rebasing or bisecting on the branch.
  return (await succeeds(workdir, ["fetch", "--quiet", ".", `HEAD:refs/heads/${main}`])) ? null : repo.path;
}

/** Land the task's branch on the repo's default branch. See the comment at the top of this file. */
export async function landTask(req: MergeRequest): Promise<MergeResult> {
  const { repo, task, workdir, emit, signal } = req;
  if (!task.branch) throw new MergeError("This task has no branch to merge");
  if (!(await revParse(repo.path, `refs/heads/${task.branch}`))) {
    throw new MergeError(`Branch ${task.branch} no longer exists`);
  }
  const remote = await remoteFor(repo);
  await prepareWorkdir(repo, workdir, task.branch);

  const attempts = req.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error("Stopped");
    const base = await resolveBase(repo, remote, emit);
    const branchSha = (await revParse(repo.path, `refs/heads/${task.branch}`))!;

    let commit: string | null = null;
    let head = base.sha;
    if (await isAncestor(repo.path, branchSha, base.sha)) {
      emit("note", `${task.branch} is already in ${base.label}`);
      await g(workdir, ["checkout", "--quiet", "--detach", base.sha]);
    } else {
      commit = head = await buildMerge(req, base);
    }
    if (signal?.aborted) throw new Error("Stopped");

    await prepareDependencies(req);
    await runChecks(workdir, req.checks ?? [], "merge", req.recordValidation ?? (() => {}), signal);
    if (signal?.aborted) throw new Error("Stopped");
    if (remote) {
      if ((await push(repo, remote, head)) === "moved") {
        emit("note", `${remote}/${repo.defaultBranch} moved while merging. Starting over from the new tip.`);
        continue;
      }
      emit("note", `Pushed to ${remote}/${repo.defaultBranch}`, { commit: head });
    }
    const checkoutBehind = await moveLocalDefault(repo, workdir, head);
    return { commit, head, pushedTo: remote, checkoutBehind };
  }
  throw new MergeError(`${remote}/${repo.defaultBranch} kept moving. Tried ${attempts} times.`);
}

/** Delete a task branch once it's merged. `-d` refuses if git doesn't see it as merged, which is fine. */
export async function deleteMergedBranch(repo: Repo, branch: string) {
  await succeeds(repo.path, ["branch", "-d", branch]);
}
