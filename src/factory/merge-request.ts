import type { EventType, Repo, Task, ValidationRun } from "@crane/contracts";
import { installDependencies } from "@crane/worktree-deps";

export class MergeError extends Error {}

export interface ResolutionReview { visualReviewRequired: boolean }

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
  /** The wait before each retry of a temporary fetch failure. Tries = waits + 1. */
  fetchRetryDelaysMs?: readonly number[];
  /** The commit the operator's visual decision is on. If it's a merge that still fits, it lands as is. */
  reviewedCandidate?: string;
}

/** The commit a merge goes onto, and how to name it to the operator. */
export interface MergeBase {
  sha: string;
  label: string;
}

/** Install what the merge needs in Crane's worktree, reporting progress on the task. */
export async function prepareDependencies(req: MergeRequest): Promise<void> {
  const note = await installDependencies(req.workdir, {
    from: req.repo.path,
    signal: req.signal,
    onProgress: (progress) => req.emit("note", progress),
  });
  if (note) req.emit("note", note);
}
