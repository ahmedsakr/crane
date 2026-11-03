import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EventType, Repo, Task } from "@crane/contracts";
import { runChecks } from "./checks.js";
import { installDependencies } from "@crane/worktree-deps";
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

interface ResolutionReview { visualReviewRequired: boolean }

export interface MergeRequest {
  /** Factory gate after candidate construction, then again after checks before any push or default-branch update. */
  verifyVisualReview?: (commit: string, tree: string, branchCommit: string, changedFiles: string[]) => Promise<void>;
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
  resolveConflicts: (ctx: { cwd: string; base: string; files: string[]; deferredDependencies?: string[] }) => Promise<void | ResolutionReview>;
  /** Runs after Crane durably commits the edits, including on recovery. No approval or check is implied by the checkpoint. */
  validateResolution?: (ctx: { cwd: string; base: string; files: string[]; checkpoint: string; visualReviewRequired: boolean }) => Promise<void | ResolutionReview>;
  /** How many times to start over when the remote moves under us. */
  maxAttempts?: number;
  /** The commit the operator's visual decision is on. If it's a merge that still fits, it lands as is. */
  reviewedCandidate?: string;
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

async function g(cwd: string, args: string[], opts: { net?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: opts.net ? NET_ENV() : process.env,
    timeout: opts.net ? 2 * 60_000 : 60_000,
    signal: opts.signal,
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
export function why(err: unknown): string {
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

/** Update the remote-tracking ref for the default branch. Touches no local branch or checkout. */
export async function fetchDefault(repo: Repo, remote: string, signal?: AbortSignal): Promise<void> {
  const main = repo.defaultBranch;
  await g(repo.path, ["fetch", "--quiet", remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`], { net: true, signal });
}

export interface DefaultTip {
  sha: string;
  label: string;
  /** Commits on the local default branch that aren't on the remote yet, as a count. */
  ahead: string | null;
  /** Whether the local default branch exists and is behind this tip. */
  localBehind: boolean;
}

/**
 * The newest of the local and remote default branch, from the refs already here.
 * Null when neither exists, "diverged" when neither contains the other.
 */
export async function newestDefault(repo: Repo, remote: string | null): Promise<DefaultTip | "diverged" | null> {
  const main = repo.defaultBranch;
  const local = await revParse(repo.path, `refs/heads/${main}`);
  const upstream = remote ? await revParse(repo.path, `refs/remotes/${remote}/${main}`) : null;
  if (!local && !upstream) return null;
  if (!upstream) return { sha: local!, label: main, ahead: null, localBehind: false };
  if (!local || local === upstream || (await isAncestor(repo.path, local, upstream))) {
    return { sha: upstream, label: `${remote}/${main}`, ahead: null, localBehind: !!local && local !== upstream };
  }
  if (await isAncestor(repo.path, upstream, local)) {
    const ahead = await g(repo.path, ["rev-list", "--count", `${upstream}..${local}`]);
    return { sha: local, label: main, ahead, localBehind: false };
  }
  return "diverged";
}

/** The commit to merge onto: the newest of the local and remote default branch. */
async function resolveBase(
  repo: Repo,
  remote: string | null,
  emit: MergeRequest["emit"],
): Promise<{ sha: string; label: string }> {
  const main = repo.defaultBranch;
  if (remote) {
    try {
      await fetchDefault(repo, remote);
    } catch (err) {
      throw new MergeError(`Couldn't fetch ${main} from ${remote}: ${why(err)}`);
    }
  }
  const tip = await newestDefault(repo, remote);
  if (!tip) throw new MergeError(`There's no ${main} branch to merge into`);
  if (tip === "diverged") {
    throw new MergeError(`Your local ${main} and ${remote}/${main} have diverged. Bring them back together (git pull), then merge again.`);
  }
  if (tip.ahead) emit("note", `Your local ${main} has ${tip.ahead} commit${tip.ahead === "1" ? "" : "s"} not on ${remote} yet. They'll be pushed too.`);
  return tip;
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

/** Files that decide what a dependency install does: manifests, lockfiles, package manager settings. */
const DEPENDENCY_INPUTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".npmrc",
  ".yarnrc.yml",
]);

/** The conflicted files a dependency install would read. */
export function dependencyInputs(files: string[]): string[] {
  return files.filter((f) => DEPENDENCY_INPUTS.has(basename(f)));
}

/** Build the merge commit on top of `base` in the workdir. Returns its sha. */
async function buildMerge(req: MergeRequest, base: { sha: string; label: string }): Promise<string> {
  const { workdir: cwd, task, emit } = req;
  const branch = task.branch!;
  const branchSha = (await revParse(cwd, `refs/heads/${branch}`))!;
  const checkpointRef = resolutionRef(task.id);
  const checkpoint = await revParse(cwd, checkpointRef);
  if (checkpoint) {
    const parents = await g(cwd, ["show", "-s", "--format=%P", checkpoint]);
    const head = await revParse(cwd, "HEAD");
    if (parents === `${base.sha} ${branchSha}` && head === checkpoint
      && !(await g(cwd, ["status", "--porcelain"]))) {
      const files = (await g(cwd, ["diff", "--name-only", "-z", base.sha, checkpoint])).split("\0").filter(Boolean);
      emit("note", `Recovered resolution checkpoint ${checkpoint.slice(0, 7)}; asking the resolver to validate it.`);
      const needsReview = await revParse(cwd, `${checkpointRef}-nonvisual`) !== checkpoint;
      return validateResolution(req, base.label, files, checkpoint, needsReview);
    }
    await g(cwd, ["update-ref", "-d", checkpointRef]);
    await g(cwd, ["update-ref", "-d", `${checkpointRef}-nonvisual`]);
    emit("note", "Discarded the resolution checkpoint because its task, base, or workspace changed.");
  }
  // Resolving the same conflicts again could give a result the operator never saw.
  const reviewed = req.reviewedCandidate;
  if (reviewed && reviewed !== branchSha && (await revParse(cwd, reviewed))
    && (await isAncestor(cwd, branchSha, reviewed)) && (await isAncestor(cwd, base.sha, reviewed))) {
    await g(cwd, ["checkout", "--quiet", "--detach", reviewed]);
    emit("note", `Using the merge you reviewed, ${reviewed.slice(0, 7)}, which is still up to date with ${base.label}`);
    return reviewed;
  }
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
    const deferred = dependencyInputs(files);
    let needsReview = true;
    try {
      if (deferred.length) {
        // A conflicted manifest or lockfile can't be installed from, so don't try.
        // landTask prepares dependencies from the resolved files before merge checks.
        emit(
          "note",
          `Deferred dependency preparation: ${deferred.join(", ")} ${deferred.length === 1 ? "is" : "are"} conflicted. Crane installs dependencies from the resolved files before merge checks.`,
          { dependencies: "deferred", files: deferred },
        );
      } else {
        try {
          await prepareDependencies(req);
        } catch (err) {
          if (req.signal?.aborted) throw err;
          emit("note", `Couldn't prepare dependencies before conflict resolution: ${why(err)}. Will retry before merge checks.`);
        }
      }
      const review = await req.resolveConflicts({ cwd, base: base.label, files, ...(deferred.length ? { deferredDependencies: deferred } : {}) });
      needsReview = review?.visualReviewRequired ?? true;
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
    // A ref keeps the candidate reachable across crashes and garbage collection.
    // This is deliberately before resolver validation, which can take minutes.
    await saveResolution(req, head, needsReview);
    emit("note", `Saved resolution checkpoint ${head.slice(0, 7)} before resolver validation.`);
    return validateResolution(req, base.label, files, head, needsReview);
  }
}

function resolutionRef(taskId: string): string {
  return `refs/crane/resolutions/${createHash("sha256").update(taskId).digest("hex")}`;
}

async function saveResolution(req: MergeRequest, head: string, needsReview: boolean): Promise<void> {
  const ref = resolutionRef(req.task.id);
  // Save an opt-out first. Missing or mismatched metadata always requires review,
  // including a crash between these writes. Neither ref grants operator approval.
  await g(req.workdir, needsReview ? ["update-ref", "-d", `${ref}-nonvisual`] : ["update-ref", `${ref}-nonvisual`, head]);
  await g(req.workdir, ["update-ref", ref, head]);
}

async function validateResolution(req: MergeRequest, base: string, files: string[], checkpoint: string, needsReview: boolean): Promise<string> {
  if (!req.validateResolution) return checkpoint;
  await prepareDependencies(req);
  const review = await req.validateResolution({ cwd: req.workdir, base, files, checkpoint, visualReviewRequired: needsReview });
  if (await revParse(req.workdir, "HEAD") !== checkpoint) throw new MergeError("The resolver moved the checkpoint HEAD");
  const left = await filesWithMarkers(req.workdir, files);
  if (left.length) throw new MergeError(`Conflicts are still unresolved in ${left.join(", ")}`);
  await g(req.workdir, ["add", "-A"]);
  if (await g(req.workdir, ["diff", "--cached", "--name-only"])) {
    await g(req.workdir, [...await identity(req.workdir), "commit", "--amend", "--no-edit", "--quiet"]);
  }
  const head = (await revParse(req.workdir, "HEAD"))!;
  await saveResolution(req, head, needsReview || (review?.visualReviewRequired ?? true));
  return head;
}

async function prepareDependencies(req: MergeRequest): Promise<void> {
  const note = await installDependencies(req.workdir, {
    from: req.repo.path,
    signal: req.signal,
    onProgress: (progress) => req.emit("note", progress),
  });
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

    const changedFiles = commit
      ? (await g(workdir, ["diff", "--name-only", "--no-renames", "-z", base.sha, head])).split("\0")
        .filter(Boolean)
      : [];
    const tree = await g(workdir, ["rev-parse", `${head}^{tree}`]);
    // Fail before expensive validation when this candidate needs an operator's
    // decision. Each remote-moved retry must authorize its own candidate.
    await req.verifyVisualReview?.(head, tree, branchSha, changedFiles);

    // Every time, including after a deferred preparation or a resolver's own
    // install: merge checks run only against dependencies Crane prepared for the
    // merge commit's manifests (it reinstalls whenever they changed).
    await prepareDependencies(req);
    await runChecks(workdir, req.checks ?? [], "merge", req.recordValidation ?? (() => {}), signal);
    if (signal?.aborted) throw new Error("Stopped");
    const changedManifests = changedFiles.filter(file => ["package.json", "package-lock.json"].includes(basename(file)));
    await req.verifyVisualReview?.(head, tree, branchSha, changedFiles);
    if (remote) {
      if ((await push(repo, remote, head)) === "moved") {
        emit("note", `${remote}/${repo.defaultBranch} moved while merging. Starting over from the new tip.`);
        continue;
      }
      emit("note", `Pushed to ${remote}/${repo.defaultBranch}`, { commit: head });
    }
    const checkoutBehind = await moveLocalDefault(repo, workdir, head);
    if (changedManifests.length) {
      emit("note", `This merge changed ${changedManifests.join(", ")}. After updating your checkout at ${checkoutBehind ?? repo.path} to ${repo.defaultBranch}, run npm install there before building or running it. Crane does not install dependencies in your checkout.`,
        { dependencyFiles: changedManifests });
    }
    await g(workdir, ["update-ref", "-d", resolutionRef(task.id)]);
    await g(workdir, ["update-ref", "-d", `${resolutionRef(task.id)}-nonvisual`]);
    return { commit, head, pushedTo: remote, checkoutBehind };
  }
  throw new MergeError(`${remote}/${repo.defaultBranch} kept moving. Tried ${attempts} times.`);
}

/** Delete a task branch once it's merged. `-d` refuses if git doesn't see it as merged, which is fine. */
export async function deleteMergedBranch(repo: Repo, branch: string) {
  await succeeds(repo.path, ["branch", "-d", branch]);
}
