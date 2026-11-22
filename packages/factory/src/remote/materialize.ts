import { existsSync, rmSync, statSync } from "node:fs";
import { RUNNER_LIMITS, type RunnerJobKind } from "@crane/contracts";
import { git } from "@crane/backend-runtime";
import { isAncestor, revParse, succeeds, why } from "../merge-git.js";
import { incomingBundlePath, incomingRef } from "./paths.js";

/**
 * Bringing a container's work back. Only Crane's code runs here, and it trusts
 * nothing in the bundle: it must verify against Crane's repo, hold exactly one
 * ref to one commit, pass Git's object checks, and stay under the size limit.
 * A work job's commits land only as a fast-forward of the commit Crane sent; a
 * merge job's commit is only a tree to copy in, and HEAD never moves.
 */

/** What Crane refused to take from a container. Nothing in the worktree changed. */
export class BundleRefused extends Error {}

/** What a returned job is applied to. */
export interface ReturnedJob {
  id: string;
  kind: RunnerJobKind;
  /** Crane's directory for the run: the task's worktree or its merge workdir. */
  cwd: string;
  /** For work jobs: the commit Crane sent (`tip ?? base`), and the branch it must be on. */
  start?: string;
  branch?: string | null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAFE_REF = /^(HEAD|refs\/[A-Za-z0-9._/-]+)$/;
const MB = 1024 * 1024;

/** The bundle's one ref and the commit it names, once it verifies against `cwd`'s repository. */
async function inspectBundle(cwd: string, file: string): Promise<{ sha: string; ref: string }> {
  const bytes = statSync(file).size;
  if (bytes > RUNNER_LIMITS.bundleBytes) {
    throw new BundleRefused(`The returned bundle is ${Math.ceil(bytes / MB)} MB, more than the ${RUNNER_LIMITS.bundleBytes / MB} MB Crane accepts`);
  }
  try {
    await git(cwd, "bundle", "verify", file);
  } catch (err) {
    throw new BundleRefused(`The returned bundle didn't verify: ${why(err)}`);
  }
  const heads = (await git(cwd, "bundle", "list-heads", file)).split("\n").filter(Boolean);
  if (heads.length !== 1) throw new BundleRefused(`The returned bundle has ${heads.length} refs; Crane accepts exactly one`);
  const [sha = "", ref = "", ...rest] = heads[0]!.split(" ");
  if (!SHA.test(sha) || !SAFE_REF.test(ref) || ref.includes("..") || rest.length) {
    throw new BundleRefused("The returned bundle's ref isn't one Crane can read");
  }
  return { sha, ref };
}

/** Fetch the bundle's commit into a ref of Crane's own, with Git checking every object. Returns the commit. */
async function fetchBundle(cwd: string, file: string, jobId: string): Promise<string> {
  const { sha, ref } = await inspectBundle(cwd, file);
  const incoming = incomingRef(jobId);
  await succeeds(cwd, ["update-ref", "-d", incoming]);
  try {
    await git(cwd, "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true",
      "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", file, `${ref}:${incoming}`);
  } catch (err) {
    throw new BundleRefused(`Git refused the returned bundle's objects: ${why(err)}`);
  }
  const type = await git(cwd, "cat-file", "-t", incoming).catch(() => "");
  const commit = await revParse(cwd, incoming);
  if (type !== "commit" || commit !== sha) throw new BundleRefused("The returned bundle's ref doesn't name a commit");
  return commit;
}

/** Fast-forward the task's worktree to the container's commit, refusing anything else. */
async function fastForward(job: ReturnedJob, commit: string): Promise<void> {
  const { cwd, start, branch } = job;
  if (!start) throw new BundleRefused("Crane has no record of the commit it sent");
  const at = await revParse(cwd, "HEAD");
  if (at !== start) {
    throw new BundleRefused(`Crane's worktree moved from ${start.slice(0, 7)} to ${at?.slice(0, 7) ?? "nothing"} while the container worked`);
  }
  if (branch) {
    const on = await git(cwd, "symbolic-ref", "-q", "--short", "HEAD").catch(() => "");
    if (on !== branch) throw new BundleRefused(`Crane's worktree isn't on ${branch}`);
  }
  // Untracked files don't block a fast-forward; git itself refuses to overwrite one.
  if (await git(cwd, "status", "--porcelain", "--untracked-files=no")) {
    throw new BundleRefused("Crane's worktree has uncommitted changes");
  }
  if (!(await isAncestor(cwd, start, commit))) {
    throw new BundleRefused(`The returned commit ${commit.slice(0, 7)} isn't a fast-forward of ${start.slice(0, 7)}, the commit Crane sent`);
  }
  if (commit === start) return;
  try {
    await git(cwd, "merge", "--ff-only", "--quiet", commit);
  } catch (err) {
    throw new BundleRefused(`Git couldn't fast-forward Crane's worktree: ${why(err)}`);
  }
}

/**
 * Copy the commit's tree into `cwd`'s index and working tree, leaving HEAD (and
 * any merge in progress) where it was. Crane's merge checks then judge it like
 * edits an agent made in place.
 */
export async function restoreTree(cwd: string, commit: string): Promise<void> {
  const before = await revParse(cwd, "HEAD");
  await git(cwd, "restore", `--source=${commit}`, "--staged", "--worktree", "--", ":/");
  if (await revParse(cwd, "HEAD") !== before) throw new Error("Restoring the container's result moved HEAD");
}

/**
 * Apply what the container returned for `job`, then forget the bundle. Returns
 * the returned commit, or null when there was nothing to apply. Throws
 * `BundleRefused`, with the worktree unchanged, when the bundle doesn't pass.
 */
export async function materialize(job: ReturnedJob): Promise<string | null> {
  const file = incomingBundlePath(job.id);
  if (!existsSync(file)) return null;
  try {
    if (job.kind === "observe") throw new BundleRefused("Investigate-only jobs return no commits");
    const commit = await fetchBundle(job.cwd, file, job.id);
    if (job.kind === "work") await fastForward(job, commit);
    else await restoreTree(job.cwd, commit);
    return commit;
  } finally {
    rmSync(file, { force: true });
    await succeeds(job.cwd, ["update-ref", "-d", incomingRef(job.id)]);
  }
}

/** Throw away a returned bundle that won't be applied. */
export function discardIncoming(jobId: string): void {
  rmSync(incomingBundlePath(jobId), { force: true });
}
