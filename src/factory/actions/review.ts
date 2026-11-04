import { visualReviewPending, type Task } from "@crane/contracts";
import type { Store } from "../../core/store.js";
import { git } from "../../core/git.js";
import { removeWorktree } from "../git.js";
import { needTask } from "./tasks.js";

/** Record candidate inspection or an explicit waiver; task pre-approval also authorizes waivers. */
export async function recordVisualReview(store: Store, id: string, input: { status: "inspected" | "waived"; commit: string; note: string }): Promise<Task> {
  const task = needTask(store, id);
  if (!input || !["inspected", "waived"].includes(input.status)) throw new Error("Visual decision must be inspected or waived");
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit)) throw new Error("Supply the full candidate commit");
  if (typeof input.note !== "string" || !input.note.trim() || input.note.length > 10000) {
    throw new Error("Record reviewed views, sizes and screenshot paths, or the waiver reason and unreviewed scope (at most 10000 characters)");
  }
  if (!task.branch || !["needs_review", "approved", "done"].includes(task.status)) throw new Error("Visual review requires a finished candidate awaiting approval or merge");
  let candidate = task.visualReview;
  // Older tasks have no structured candidate. Resolve their branch without changing the operator's checkout.
  if (!candidate) {
    const repo = task.repoId ? store.getRepo(task.repoId) : null;
    if (!repo) throw new Error("This task has no candidate repo");
    candidate = { status: "pending", commit: await git(repo.path, "rev-parse", `refs/heads/${task.branch}^{commit}`),
      tree: await git(repo.path, "rev-parse", `refs/heads/${task.branch}^{tree}`), note: "", decidedAt: null };
  }
  const expected = candidate;
  return store.transaction(() => {
    const current = needTask(store, id);
    if (current.status !== task.status || (current.visualReview?.commit ?? null) !== (task.visualReview?.commit ?? null)
      || input.commit !== expected.commit) throw new Error("The candidate changed; inspect its current commit and record a new decision");
    const review = { ...expected, status: input.status, note: input.note.trim(), decidedAt: new Date().toISOString() };
    store.updateTask(id, { visualReview: review });
    store.addEvent(id, "operator", input.status === "inspected" ? "Recorded candidate visual inspection" : "Waived candidate visual review", { visualReview: review });
    return needTask(store, id);
  }, { immediate: true });
}

function requireVisualReview(task: Task) {
  if (visualReviewPending(task)) throw new Error("Record candidate visual inspection or an explicit operator waiver before approval or merge");
}

/**
 * Approve a task. When it changed code, this also merges its branch into the
 * repo's default branch and pushes it, unless `merge: false` ("Approve only").
 */
export async function approve(store: Store, id: string, note?: string, opts: { merge?: boolean } = {}): Promise<Task> {
  const m = needTask(store, id);
  if (m.status !== "needs_review") throw new Error(`Task ${m.id} isn't waiting for review`);
  if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
  if (opts.merge !== undefined && typeof opts.merge !== "boolean") throw new Error("Merge must be a boolean");
  requireVisualReview(m);
  const merging = (opts.merge ?? true) && !!m.branch;
  store.addEvent(m.id, "operator", note ? `Approved: ${note}` : "Approved");
  if (merging) return queueMerge(store, m);
  await cleanupWorktree(store, m, false);
  store.setStatus(m.id, "approved", m.branch ? `Approved. Branch ${m.branch} is kept for you to merge` : "Approved");
  return needTask(store, id);
}

/**
 * Approve a queued or running task ahead of time. When its run finishes and
 * its checks pass, it goes straight to the merge queue instead of waiting for
 * review, waiving visual review too. A failed run or check fails the task as
 * usual, and a merge that can't land comes back for review. `undoPreApproval`
 * takes it back.
 */
export function preApprove(store: Store, id: string, note?: string): Task {
  const m = needTask(store, id);
  if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
  if (m.autonomy === "observe") throw new Error(`Task ${m.id} is investigate-only, so it has nothing to merge`);
  if (m.status === "needs_review") throw new Error(`Task ${m.id} is already waiting for review. Approve it instead`);
  if (m.preApprovedAt) throw new Error(`Task ${m.id} is already pre-approved`);
  if (!store.setPreApproval(m.id, true)) throw new Error(`Task ${m.id} isn't queued or running, so it can't be pre-approved`);
  store.addEvent(m.id, "operator", note ? `Pre-approved: ${note}` : "Pre-approved", { preApproved: true });
  return needTask(store, id);
}

/** Take back a pre-approval, so the task waits for review when it finishes. */
export function undoPreApproval(store: Store, id: string): Task {
  const m = needTask(store, id);
  if (!m.preApprovedAt) throw new Error(`Task ${m.id} isn't pre-approved`);
  if (!store.setPreApproval(m.id, false)) {
    throw new Error(`Task ${m.id} has already finished its run, so its pre-approval can't be undone`);
  }
  store.addEvent(m.id, "operator", "Undid pre-approval. It waits for your review", { preApproved: false });
  return needTask(store, id);
}

/** Merge a task's branch into the default branch and push it. For tasks already approved or done. */
export async function merge(store: Store, id: string): Promise<Task> {
  const m = needTask(store, id);
  if (m.status === "needs_review") return approve(store, id);
  if (!m.branch) throw new Error(`Task ${m.id} didn't change any code, so there's nothing to merge`);
  if (!["approved", "done"].includes(m.status)) throw new Error(`Task ${m.id} isn't ready to merge`);
  requireVisualReview(m);
  store.addEvent(m.id, "operator", "Asked to merge");
  return queueMerge(store, m);
}

/** Hand the task to the factory, which merges it with the next free agent. */
function queueMerge(store: Store, m: Task): Task {
  const repo = m.repoId ? store.getRepo(m.repoId) : null;
  if (!repo) throw new Error(`Task ${m.id} has no repo to merge into`);
  store.updateTask(m.id, { agentId: null });
  store.setStatus(m.id, "merging", `Waiting to merge into ${repo.defaultBranch}`);
  return needTask(store, m.id);
}

export async function reject(store: Store, id: string, note?: string): Promise<Task> {
  const m = needTask(store, id);
  if (m.status !== "needs_review") throw new Error(`Task ${m.id} isn't waiting for review`);
  if (note !== undefined && typeof note !== "string") throw new Error("Note must be text");
  store.addEvent(m.id, "operator", note ? `Declined: ${note}` : "Declined");
  await cleanupWorktree(store, m, true);
  store.setStatus(m.id, "rejected", "Declined");
  return needTask(store, id);
}

async function cleanupWorktree(store: Store, m: Task, deleteBranch: boolean) {
  if (!m.worktree || !m.repoId) return;
  const repo = store.getRepo(m.repoId);
  if (!repo) return;
  await removeWorktree(repo, m.worktree, deleteBranch && m.branch ? { deleteBranch: m.branch } : {});
  store.updateTask(m.id, { worktree: null, ...(deleteBranch ? { branch: null } : {}) });
}
