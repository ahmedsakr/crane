import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Repo } from "@crane/contracts";
import { runChecks } from "./checks.js";
import { clearResolution, nonvisualRef, resolutionRef, resolveMergeConflicts, unmergedFiles, validateResolution } from "./merge-conflicts.js";
import { fetchForMerge } from "./merge-fetch.js";
import { g, identity, isAncestor, newestDefault, remoteFor, revParse, succeeds, why } from "./merge-git.js";
import { MergeError, prepareDependencies, type MergeBase, type MergeRequest } from "./merge-request.js";

export { dependencyInputs } from "./merge-conflicts.js";
export { isTransientFetchFailure } from "./merge-fetch.js";
export { MergeError, type MergeRequest } from "./merge-request.js";

/**
 * Landing an approved task on the default branch.
 *
 * Crane's own code does every git step here; agents never do. Only conflict
 * resolution goes to an agent, which edits files inside Crane's worktree and
 * nothing else. The shape is the one an operator would do by hand:
 *
 *   1. Fetch the default branch and take the newest of local and remote. A
 *      temporary network failure gets a few spaced-out tries; nothing goes on
 *      without a fetch that succeeded.
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
 * This file holds the only code that moves a default branch: `push` and `moveLocalDefault`.
 */

export interface MergeResult {
  /** The merge commit Crane made, or null if the branch was already in the default branch. */
  commit: string | null;
  /** Where the default branch now points. */
  head: string;
  pushedTo: string | null;
  /** A checkout of the default branch that was left behind because it had local changes. */
  checkoutBehind: string | null;
}

/** What one attempt would land: authorized and checked as a whole, and never reused by a later attempt. */
interface Candidate {
  /** The merge commit Crane made, or null if the branch was already in the default branch. */
  commit: string | null;
  head: string;
  tree: string;
  branchSha: string;
  changedFiles: string[];
}

/** Where a branch is checked out, if anywhere. */
async function checkoutOf(repo: Repo, branch: string): Promise<string | null> {
  const out = await g(repo.path, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

// ── steps ───────────────────────────────────────────────────

function stopIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Stopped");
}

/** The task's branch, once it's known to exist. */
async function requireBranch({ repo, task }: MergeRequest): Promise<string> {
  if (!task.branch) throw new MergeError("This task has no branch to merge");
  if (!(await revParse(repo.path, `refs/heads/${task.branch}`))) {
    throw new MergeError(`Branch ${task.branch} no longer exists`);
  }
  return task.branch;
}

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
async function resolveBase(req: MergeRequest, remote: string | null): Promise<MergeBase> {
  const { repo, emit } = req;
  const main = repo.defaultBranch;
  if (remote) await fetchForMerge(req, remote);
  const tip = await newestDefault(repo, remote);
  if (!tip) throw new MergeError(`There's no ${main} branch to merge into`);
  if (tip === "diverged") {
    throw new MergeError(`Your local ${main} and ${remote}/${main} have diverged. Bring them back together (git pull), then merge again.`);
  }
  if (tip.ahead) emit("note", `Your local ${main} has ${tip.ahead} commit${tip.ahead === "1" ? "" : "s"} not on ${remote} yet. They'll be pushed too.`);
  return tip;
}

/** Build the merge commit on top of `base` in the workdir. Returns its sha. */
async function buildMerge(req: MergeRequest, base: MergeBase): Promise<string> {
  const branchSha = (await revParse(req.workdir, `refs/heads/${req.task.branch!}`))!;
  return (await recoverCheckpoint(req, base, branchSha))
    ?? (await reuseReviewedCandidate(req, base, branchSha))
    ?? attemptMerge(req, base, branchSha);
}

/**
 * Pick up a resolution an earlier run saved, but only when its parents are exactly
 * this base and branch and the clean worktree is still on it. Anything else means
 * its inputs changed, so it's discarded. Returns null when there's nothing to recover.
 */
async function recoverCheckpoint(req: MergeRequest, base: MergeBase, branchSha: string): Promise<string | null> {
  const { workdir: cwd, task, emit } = req;
  const checkpoint = await revParse(cwd, resolutionRef(task.id));
  if (!checkpoint) return null;
  const parents = await g(cwd, ["show", "-s", "--format=%P", checkpoint]);
  const head = await revParse(cwd, "HEAD");
  if (parents === `${base.sha} ${branchSha}` && head === checkpoint
    && !(await g(cwd, ["status", "--porcelain"]))) {
    const files = (await g(cwd, ["diff", "--name-only", "-z", base.sha, checkpoint])).split("\0").filter(Boolean);
    emit("note", `Recovered resolution checkpoint ${checkpoint.slice(0, 7)}; asking the resolver to validate it.`);
    const needsReview = await revParse(cwd, nonvisualRef(task.id)) !== checkpoint;
    return validateResolution(req, base.label, files, checkpoint, needsReview);
  }
  await clearResolution(cwd, task.id);
  emit("note", "Discarded the resolution checkpoint because its task, base, or workspace changed.");
  return null;
}

/** Land the merge the operator reviewed if it still contains both sides. Resolving the same conflicts again could give a result they never saw. */
async function reuseReviewedCandidate(req: MergeRequest, base: MergeBase, branchSha: string): Promise<string | null> {
  const { workdir: cwd, reviewedCandidate: reviewed, emit } = req;
  if (!reviewed || reviewed === branchSha || !(await revParse(cwd, reviewed))
    || !(await isAncestor(cwd, branchSha, reviewed)) || !(await isAncestor(cwd, base.sha, reviewed))) {
    return null;
  }
  await g(cwd, ["checkout", "--quiet", "--detach", reviewed]);
  emit("note", `Using the merge you reviewed, ${reviewed.slice(0, 7)}, which is still up to date with ${base.label}`);
  return reviewed;
}

/** Merge the task's branch onto `base`, going to the resolver if it stops on conflicts. */
async function attemptMerge(req: MergeRequest, base: MergeBase, branchSha: string): Promise<string> {
  const { workdir: cwd, task } = req;
  const branch = task.branch!;
  await g(cwd, ["checkout", "--quiet", "--detach", base.sha]);
  const message = `Merge branch '${branch}'\n\nTask ${task.id}: ${task.title}`;
  const id = await identity(cwd);
  try {
    await g(cwd, [...id, "merge", "--no-ff", "--no-edit", "-m", message, branch]);
    return await g(cwd, ["rev-parse", "HEAD"]);
  } catch (err) {
    const files = await unmergedFiles(cwd);
    if (!files.length) {
      await succeeds(cwd, ["merge", "--abort"]);
      throw new MergeError(`git couldn't merge ${branch}: ${why(err)}`);
    }
    return resolveMergeConflicts(req, { base, branchSha, id, files });
  }
}

/** What this attempt would land on `base`: a new merge, or the base itself when the branch is already in it. */
async function buildCandidate(req: MergeRequest, base: MergeBase): Promise<Candidate> {
  const { repo, task, workdir, emit, signal } = req;
  const branchSha = (await revParse(repo.path, `refs/heads/${task.branch!}`))!;
  let commit: string | null = null;
  if (await isAncestor(repo.path, branchSha, base.sha)) {
    emit("note", `${task.branch} is already in ${base.label}`);
    await g(workdir, ["checkout", "--quiet", "--detach", base.sha]);
  } else {
    commit = await buildMerge(req, base);
  }
  stopIfAborted(signal);
  const head = commit ?? base.sha;
  const changedFiles = commit
    ? (await g(workdir, ["diff", "--name-only", "--no-renames", "-z", base.sha, head])).split("\0")
      .filter(Boolean)
    : [];
  const tree = await g(workdir, ["rev-parse", `${head}^{tree}`]);
  return { commit, head, tree, branchSha, changedFiles };
}

/** Everything a candidate must pass before anything is pushed or moved. */
async function verifyCandidate(req: MergeRequest, { head, tree, branchSha, changedFiles }: Candidate): Promise<void> {
  const { workdir, signal } = req;
  // Fail before expensive validation when this candidate needs an operator's
  // decision. Each remote-moved retry must authorize its own candidate.
  await req.verifyVisualReview?.(head, tree, branchSha, changedFiles);

  // Every time, including after a deferred preparation or a resolver's own
  // install: merge checks run only against dependencies Crane prepared for the
  // merge commit's manifests (it reinstalls whenever they changed).
  await prepareDependencies(req);
  await runChecks(workdir, req.checks ?? [], "merge", req.recordValidation ?? (() => {}), signal);
  stopIfAborted(signal);
  await req.verifyVisualReview?.(head, tree, branchSha, changedFiles);
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

/** Push the candidate, if there's a remote to push to. "moved" means this attempt has to start over. */
async function publish({ repo, emit }: MergeRequest, remote: string | null, head: string): Promise<"ok" | "moved"> {
  if (!remote) return "ok";
  if ((await push(repo, remote, head)) === "moved") {
    emit("note", `${remote}/${repo.defaultBranch} moved while merging. Starting over from the new tip.`);
    return "moved";
  }
  emit("note", `Pushed to ${remote}/${repo.defaultBranch}`, { commit: head });
  return "ok";
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

/** Tell the operator to install if this merge changed what their checkout depends on. Crane won't do it for them. */
function noteChangedManifests({ repo, emit }: MergeRequest, changedFiles: string[], checkoutBehind: string | null) {
  const changedManifests = changedFiles.filter(file => ["package.json", "package-lock.json"].includes(basename(file)));
  if (!changedManifests.length) return;
  emit("note", `This merge changed ${changedManifests.join(", ")}. After updating your checkout at ${checkoutBehind ?? repo.path} to ${repo.defaultBranch}, run npm install there before building or running it. Crane does not install dependencies in your checkout.`,
    { dependencyFiles: changedManifests });
}

/** Land the task's branch on the repo's default branch. See the comment at the top of this file. */
export async function landTask(req: MergeRequest): Promise<MergeResult> {
  const { repo, task, workdir, signal } = req;
  const branch = await requireBranch(req);
  const remote = await remoteFor(repo);
  await prepareWorkdir(repo, workdir, branch);

  const attempts = req.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    stopIfAborted(signal);
    const base = await resolveBase(req, remote);
    const candidate = await buildCandidate(req, base);
    await verifyCandidate(req, candidate);
    if ((await publish(req, remote, candidate.head)) === "moved") continue;

    const checkoutBehind = await moveLocalDefault(repo, workdir, candidate.head);
    noteChangedManifests(req, candidate.changedFiles, checkoutBehind);
    await clearResolution(workdir, task.id);
    return { commit: candidate.commit, head: candidate.head, pushedTo: remote, checkoutBehind };
  }
  throw new MergeError(`${remote}/${repo.defaultBranch} kept moving. Tried ${attempts} times.`);
}

/** Delete a task branch once it's merged. `-d` refuses if git doesn't see it as merged, which is fine. */
export async function deleteMergedBranch(repo: Repo, branch: string) {
  await succeeds(repo.path, ["branch", "-d", branch]);
}
