import type { Report, VisualReview } from "@crane/contracts";
import { git } from "@crane/backend-runtime";
import type { Store } from "@crane/storage";

const hasUiFiles = (files: string[]) => files.some(file => /(^|\/)(web|public)\/|\.(tsx|jsx|css|scss|html|vue|svelte)$/i.test(file));

/** The operator recorded a decision, as opposed to Crane classifying the work or still waiting for one. */
export function hasVisualDecision(review: VisualReview | null | undefined): review is VisualReview {
  return review?.status === "inspected" || review?.status === "waived";
}

export interface VisualCandidate {
  /** The merge candidate's commit and tree. */
  commit: string;
  tree: string;
  /** The task branch's tip that the candidate merges. */
  branchCommit: string;
  changedFiles: string[];
  /** An agent changed UI files while resolving this candidate's conflicts or fixing its merge checks. */
  conflictChangedUi?: boolean;
}

/**
 * Whether a merge candidate may land. A decision covers the task's own work, so
 * it carries across a clean merge onto a newer default branch: that adds only
 * what has already landed. It stops covering the candidate when the branch gets
 * new commits, or when `conflictChangedUi` says an agent changed UI files while
 * resolving conflicts or fixing merge checks, since nobody has seen that result. Task pre-approval
 * authorizes a fresh waiver for any such candidate, including UI conflicts.
 */
export function requireCandidateVisualReview(store: Store, taskId: string, candidate: VisualCandidate): void {
  const { commit, tree, branchCommit, changedFiles, conflictChangedUi = false } = candidate;
  const review = store.getTask(taskId)?.visualReview;
  if (hasVisualDecision(review) && review.tree === tree) return;
  if (!conflictChangedUi) {
    // A non-UI classification applies only to the branch Crane classified, not subsequent edits.
    if (review?.status === "not_required" && review.commit === branchCommit && !hasUiFiles(changedFiles)) return;
    if (hasVisualDecision(review) && (review.branchCommit ?? review.commit) === branchCommit) return;
  }
  if (store.waivePreApprovedVisualReview(taskId, { status: "pending", commit, tree, branchCommit, decidedAt: null, note: "" })) return;
  store.updateTask(taskId, { visualReview: {
    status: "pending", commit, tree, branchCommit, decidedAt: null,
    note: conflictChangedUi
      ? "An agent changed UI files while resolving conflicts or fixing merge checks. Inspect this merge before it lands, or explicitly waive visual review."
      : "No visual decision covers these changes. Inspect this candidate before merging, or explicitly waive visual review.",
  } });
  throw new Error("Candidate visual inspection or an explicit operator waiver is required before merging");
}

/** Missing classification fails closed; recognizable UI files also override a mistaken opt-out. */
export function visualReviewRequired(report: Report): boolean {
  return report.visualReview?.required !== false || hasUiFiles(report.changedFiles) || !!report.screenshots?.length;
}

export async function candidateVisualReview(cwd: string, report: Report): Promise<VisualReview> {
  return {
    status: visualReviewRequired(report) ? "pending" : "not_required",
    commit: await git(cwd, "rev-parse", "HEAD"),
    tree: await git(cwd, "rev-parse", "HEAD^{tree}"),
    note: report.visualReview?.reason ?? "The agent did not classify visual review; operator review is required.",
    decidedAt: null,
  };
}
