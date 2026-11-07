import type { ValidationRun } from "@crane/contracts";
import type { FailedCheck } from "@crane/agent-protocol";
import { resolutionRef, saveResolution } from "./merge-conflicts.js";
import { g, identity, isAncestor, revParse, succeeds } from "./merge-git.js";
import { MergeError, type MergeBase, type MergeRequest } from "./merge-request.js";

/**
 * Fixing a merge that git built cleanly but that failed the repository's merge
 * checks, usually because something that landed on the default branch no longer
 * fits the task's change. An agent edits files in Crane's worktree; Crane's code
 * does every git step around it, and every check runs again on the result.
 */

/** About what one screen of a failing test run holds, per check. */
const EXCERPT_CHARS = 24_000;
/** The most lines kept from one failing test's details. */
const FAILURE_LINES = 60;

/** The merge commit whose checks failed. */
export interface FailedMerge {
  commit: string;
  base: MergeBase;
  branchSha: string;
}

/**
 * The checks an agent may fix: some failed, and everything else passed. A
 * blocked check never judged the candidate, and one that changed it can't be
 * trusted, so either hands the merge straight back.
 */
export function fixableFailures(runs: ValidationRun[]): ValidationRun[] {
  if (!runs.every((r) => r.status === "passed" || r.status === "failed")) return [];
  return runs.filter((r) => r.status === "failed" && r.command);
}

/**
 * Have the agent fix a merge's failed checks, then amend its edits into the
 * merge commit, which keeps both parents. Returns the new candidate's sha. A
 * fix that changes nothing hands the merge back to the operator.
 */
export async function fixFailedChecks(req: MergeRequest, merge: FailedMerge, failed: ValidationRun[]): Promise<string> {
  const { workdir: cwd, emit } = req;
  const { commit, base, branchSha } = merge;
  const failures: FailedCheck[] = failed.map((r) => ({ command: r.command!, exitCode: r.exitCode, logs: failureExcerpt(r.logs) }));
  const commands = failures.map((f) => f.command);
  emit("note", `Merge checks failed on the merge with ${base.label}: ${commands.join(", ")}. Asking an agent to fix the merge.`, { fixChecks: commands });
  const review = await askFixer(req, { cwd, base: base.label, commit, failures });
  await returnToMerge(cwd, commit);
  await g(cwd, ["add", "-A"]);
  const files = (await g(cwd, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (!files.length) throw new MergeError(`Merge checks failed (${commands.join(", ")}), and the agent asked to fix them changed nothing`);
  await g(cwd, [...await identity(cwd), "commit", "--amend", "--no-edit", "--quiet"]);
  const head = await g(cwd, ["rev-parse", "HEAD"]);
  if (!(await isAncestor(cwd, branchSha, head)) || !(await isAncestor(cwd, base.sha, head))) {
    throw new MergeError("The fixed merge doesn't contain both the task and the default branch");
  }
  await keepResolution(req, commit, head, review?.visualReviewRequired ?? true);
  emit("note", `An agent changed ${files.length} file${files.length === 1 ? "" : "s"} to fix the merge: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}. Running the merge checks again.`,
    { fixedFiles: files });
  return head;
}

/** Run the fixer, putting the worktree back on the merge commit if it fails or is stopped. */
async function askFixer(req: MergeRequest, ctx: Parameters<NonNullable<MergeRequest["fixChecks"]>>[0]) {
  try {
    return await req.fixChecks!(ctx);
  } catch (err) {
    await succeeds(ctx.cwd, ["reset", "--hard", "--quiet", ctx.commit]);
    throw err;
  }
}

/**
 * Put HEAD back on the merge commit, keeping the agent's edits. An agent that
 * committed despite being asked not to keeps its work; one that moved HEAD
 * anywhere else may have left a tree that drops a side, so it's discarded.
 */
async function returnToMerge(cwd: string, commit: string): Promise<void> {
  const head = await revParse(cwd, "HEAD");
  if (head === commit) return;
  if (head && await isAncestor(cwd, commit, head)) {
    await g(cwd, ["reset", "--soft", "--quiet", commit]);
    return;
  }
  await succeeds(cwd, ["reset", "--hard", "--quiet", commit]);
  throw new MergeError("The agent fixing the merge checks moved HEAD off the merge, so its changes were discarded");
}

/**
 * A merge that came from a conflict resolution has a checkpoint holding the
 * resolver's edits. Move it to the fixed merge so a restart keeps both; a
 * clean merge has none, and a restart simply merges and checks it again.
 */
async function keepResolution(req: MergeRequest, before: string, after: string, needsReview: boolean): Promise<void> {
  if (await revParse(req.workdir, resolutionRef(req.task.id)) !== before) return;
  await saveResolution(req, after, needsReview);
}

/** Files changed in `cwd` since `commit`, committed or not, including new ones. */
export async function filesChangedSince(cwd: string, commit: string): Promise<string[]> {
  const changed = (await g(cwd, ["diff", "--name-only", "-z", commit])).split("\0");
  const added = (await g(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0");
  return [...new Set([...changed, ...added].filter(Boolean))];
}

/**
 * The part of a failed check's log worth an agent's attention. A long test run
 * puts its failures in the middle, so failing TAP tests come first, then as
 * much of the end, where the verdict is, as fits.
 */
export function failureExcerpt(logs: string, limit = EXCERPT_CHARS): string {
  if (logs.length <= limit) return logs;
  const failing = tapFailures(logs).slice(0, Math.floor(limit / 2));
  const tail = logs.slice(-(limit - failing.length));
  const parts = [`[${logs.length - tail.length} characters of output omitted; run the check to see all of it]`];
  if (failing) parts.push(`Failing tests:\n${failing}`, "End of the output:");
  return [...parts, tail].join("\n\n");
}

/** Each `not ok` line of TAP output with the details under it. */
function tapFailures(logs: string): string {
  const lines = logs.split("\n");
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*not ok\b/.test(line)) return;
    const end = lines.findIndex((next, j) => j > i && /^\s*(ok|not ok)\b|^\s*# Subtest:/.test(next));
    blocks.push(lines.slice(i, Math.min(end === -1 ? lines.length : end, i + FAILURE_LINES)).join("\n"));
  });
  return blocks.join("\n");
}
