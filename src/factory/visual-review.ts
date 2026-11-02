import type { Report, VisualReview } from "@crane/contracts";
import { git } from "../core/git.js";
import type { Store } from "../core/store.js";

const hasUiFiles = (files: string[]) => files.some(file => /(^|\/)(web|public)\/|\.(tsx|jsx|css|scss|html|vue|svelte)$/i.test(file));

export function requireCandidateVisualReview(store: Store, taskId: string, commit: string, tree: string, branchCommit: string, changedFiles: string[]): void {
  const review = store.getTask(taskId)?.visualReview;
  // A non-UI classification applies only to the branch Crane classified, not subsequent edits.
  if (review?.status === "not_required" && review.commit === branchCommit && !hasUiFiles(changedFiles)) return;
  if (review && (review.status === "inspected" || review.status === "waived") && review.tree === tree) return;
  store.updateTask(taskId, { visualReview: {
    status: "pending", commit, tree, decidedAt: null,
    note: "Inspect this candidate before merging, or explicitly waive visual review. The candidate may have changed during merging.",
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
