import { completionReviewReason, unmetAcceptance, type Task, type TaskStatus, type VisualReview } from "@crane/contracts";
import { postmortemBrief, postmortemPrompt as buildPostmortemPrompt, postmortemSourceMissing } from "../postmortem.js";
import type { Store } from "../store.js";
import { now } from "./shared.js";

/**
 * Pre-approve a task, or take that back, while it's still queued or running.
 * One conditional write, so it can't land after the run has already handed
 * the task to review. Returns whether it applied.
 */
export function setPreApproval(store: Store, id: string, on: boolean): boolean {
  return store.db
    .prepare(
      `UPDATE tasks SET pre_approved_at = ? WHERE id = ? AND status IN ('queued', 'running') AND autonomy != 'observe'`,
    )
    .run(on ? now() : null, id).changes > 0;
}

/** Record the candidate waiver authorized by the operator's task pre-approval. */
export function waivePreApprovedVisualReview(store: Store, id: string, candidate: VisualReview): boolean {
  return store.db.transaction(() => {
    const task = store.getTask(id);
    if (!task?.preApprovedAt || task.autonomy === "observe") return false;
    const review: VisualReview = { ...candidate, status: "waived", decidedAt: now(),
      note: "Visual review waived by operator pre-approval for this task, including conflict resolutions. All views and viewport sizes may remain unreviewed." };
    store.updateTask(id, { visualReview: review });
    store.addEvent(id, "note", "Visual review waived by pre-approval", { preApprovedAt: task.preApprovedAt, visualReview: review });
    return true;
  }).immediate();
}

/**
 * Hand a task over once its work run passed: to review (`needs_review`), as
 * done, or, when the operator pre-approved it and it has a branch, straight to
 * the merge queue. One transaction, so a pre-approval or cancel racing the end
 * of the run either counts or doesn't. Returns the new status, or null if the
 * task was cancelled meanwhile.
 */
export function finishWork(store: Store, id: string, outcome: "needs_review" | "done"): TaskStatus | null {
  return store.db.transaction(() => {
    const task = store.getTask(id);
    if (!task || task.status === "cancelled") return null;
    if (task.visualReview?.status === "pending") store.waivePreApprovedVisualReview(id, task.visualReview);
    const completionHold = completionReviewReason(task);
    if (completionHold) {
      store.setStatus(id, "needs_review", `Implementation requires operator review: ${completionHold}`, { completionHold });
      return "needs_review" as const;
    }
    // Completion alone doesn't satisfy separately requested acceptance criteria.
    const unmet = unmetAcceptance(task);
    if (task.preApprovedAt && task.branch && task.autonomy !== "observe" && unmet.length) {
      store.setStatus(id, "needs_review",
        `Pre-approved, but the report doesn't show ${unmet.length === 1 ? "an acceptance criterion" : `${unmet.length} acceptance criteria`} met. Ready for your review`,
        { acceptanceUnmet: unmet });
      return "needs_review" as const;
    }
    if (task.preApprovedAt && task.branch && task.autonomy !== "observe") {
      const main = (task.repoId && store.getRepo(task.repoId)?.defaultBranch) || "main";
      // Free for any agent to claim, and queued by when the work finished.
      store.updateTask(id, { agentId: null, finishedAt: now() });
      store.setStatus(id, "merging", `Checks passed. Waiting to merge into ${main}, as you pre-approved`, { preApproved: true });
      return "merging" as const;
    }
    store.setStatus(id, outcome, outcome === "needs_review" ? "Ready for your review" : "Done");
    return outcome;
  }).immediate();
}

/** Persist the successful merge and its follow-up together, including across restarts. */
export function completeMerge(store: Store, id: string, message: string, data: Record<string, unknown>): Task | null {
  return store.db.transaction(() => {
    const task = store.getTask(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (task.status === "merged") return null;
    if (task.status !== "merging") throw new Error(`Task ${id} isn't merging`);
    store.updateTask(id, { worktree: null });
    store.setStatus(id, "merged", message, data);
    const defaults = store.postmortemSettings();
    const review = store.createTask({
      kind: "maintenance",
      title: `Post-mortem: ${task.title}`,
      brief: postmortemBrief(task),
      repoId: task.repoId,
      autonomy: "observe",
      driver: defaults.driver ?? task.driver,
      driverSettings: defaults.driver ? { model: defaults.model, effort: defaults.effort } : null,
      postmortemOf: id,
    });
    store.addEvent(id, "note", "Queued a post-mortem to look for task friction", { postmortemTaskId: review.id });
    store.addEvent(review.id, "note", `Reviewing merged task ${id}`, { sourceTaskId: id });
    return review;
  }).immediate();
}

/** The brief a post-mortem's agent reviews, built from its merged task's current history. */
export function postmortemPrompt(store: Store, sourceTaskId: string): string {
  const source = store.getTask(sourceTaskId);
  return source ? buildPostmortemPrompt(source, store.listEvents(source.id)) : postmortemSourceMissing(sourceTaskId);
}
