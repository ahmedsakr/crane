import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { g, identity, isAncestor, revParse, succeeds, why } from "./merge-git.js";
import { MergeError, prepareDependencies, type MergeBase, type MergeRequest } from "./merge-request.js";

/**
 * Getting a merge that stopped on conflicts to a committed candidate, and the
 * checkpoint that keeps that candidate across a restart. An agent edits files in
 * Crane's worktree; Crane's code does every git step around it.
 */

const MARKER = /^(<{7}|>{7})(\s|$)/m;

/** Files from the conflict list that still contain conflict markers. */
async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
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

/** Files git still lists as unmerged in `cwd`. */
export async function unmergedFiles(cwd: string): Promise<string[]> {
  return (await g(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
}

/** A merge stopped on conflicts in the workdir. */
export interface StoppedMerge {
  base: MergeBase;
  branchSha: string;
  /** The git identity flags to commit with. */
  id: string[];
  files: string[];
}

/** Have the resolver settle a stopped merge, commit the result and checkpoint it. Returns the candidate's sha. */
export async function resolveMergeConflicts(req: MergeRequest, merge: StoppedMerge): Promise<string> {
  const { workdir: cwd, emit } = req;
  const { base, branchSha, id, files } = merge;
  emit("note", conflictNote(files, base.label), { conflicts: files });
  const needsReview = await askResolver(req, base.label, files);
  await stageResolvedFiles(cwd, files);
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

function conflictNote(files: string[], base: string): string {
  const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
  const named = `${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}`;
  return `${count} conflict with ${base}: ${named}. Asking an agent to resolve ${files.length === 1 ? "it" : "them"}.`;
}

/** Run the resolver on the stopped merge, aborting it if that fails. Returns whether the result needs visual review. */
async function askResolver(req: MergeRequest, base: string, files: string[]): Promise<boolean> {
  const { workdir: cwd } = req;
  const deferred = dependencyInputs(files);
  try {
    await prepareForResolver(req, deferred);
    const review = await req.resolveConflicts({ cwd, base, files, ...(deferred.length ? { deferredDependencies: deferred } : {}) });
    return review?.visualReviewRequired ?? true;
  } catch (err) {
    await succeeds(cwd, ["merge", "--abort"]);
    throw err;
  }
}

/** Dependencies for the resolver to work with, on a best-effort basis: merge checks get their own preparation. */
async function prepareForResolver(req: MergeRequest, deferred: string[]): Promise<void> {
  if (deferred.length) {
    // A conflicted manifest or lockfile can't be installed from, so don't try.
    // landTask prepares dependencies from the resolved files before merge checks.
    req.emit(
      "note",
      `Deferred dependency preparation: ${deferred.join(", ")} ${deferred.length === 1 ? "is" : "are"} conflicted. Crane installs dependencies from the resolved files before merge checks.`,
      { dependencies: "deferred", files: deferred },
    );
    return;
  }
  try {
    await prepareDependencies(req);
  } catch (err) {
    if (req.signal?.aborted) throw err;
    req.emit("note", `Couldn't prepare dependencies before conflict resolution: ${why(err)}. Will retry before merge checks.`);
  }
}

/** Stage the resolver's work, aborting the merge if any conflict is left. */
async function stageResolvedFiles(cwd: string, files: string[]): Promise<void> {
  const left = await filesWithMarkers(cwd, files);
  if (left.length) throw await abandonUnresolved(cwd, left);
  await g(cwd, ["add", "-A"]);
  const unmerged = await unmergedFiles(cwd);
  if (unmerged.length) throw await abandonUnresolved(cwd, unmerged);
}

async function abandonUnresolved(cwd: string, files: string[]): Promise<MergeError> {
  await succeeds(cwd, ["merge", "--abort"]);
  return new MergeError(`Conflicts are still unresolved in ${files.join(", ")}`);
}

/** Holds the resolved candidate. Records edits, never successful validation or operator approval. */
export function resolutionRef(taskId: string): string {
  return `refs/crane/resolutions/${createHash("sha256").update(taskId).digest("hex")}`;
}

/** Binds a visual-review opt-out to one candidate: it counts only when this points at that exact commit. */
export function nonvisualRef(taskId: string): string {
  return `${resolutionRef(taskId)}-nonvisual`;
}

/** Point the checkpoint at `head`, with a visual-review opt-out only when `needsReview` is false. */
export async function saveResolution(req: MergeRequest, head: string, needsReview: boolean): Promise<void> {
  const nonvisual = nonvisualRef(req.task.id);
  // Save an opt-out first. Missing or mismatched metadata always requires review,
  // including a crash between these writes. Neither ref grants operator approval.
  await g(req.workdir, needsReview ? ["update-ref", "-d", nonvisual] : ["update-ref", nonvisual, head]);
  await g(req.workdir, ["update-ref", resolutionRef(req.task.id), head]);
}

/** Delete a task's checkpoint and the opt-out bound to it. */
export async function clearResolution(cwd: string, taskId: string): Promise<void> {
  await g(cwd, ["update-ref", "-d", resolutionRef(taskId)]);
  await g(cwd, ["update-ref", "-d", nonvisualRef(taskId)]);
}

/** Have the resolver check a saved checkpoint, keeping any fixes it made. Returns the candidate's sha. */
export async function validateResolution(req: MergeRequest, base: string, files: string[], checkpoint: string, needsReview: boolean): Promise<string> {
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
