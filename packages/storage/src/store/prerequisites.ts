import { lastMergeOutcome, prerequisiteMet, type FollowUpSource, type FollowUpState, type PrerequisiteState, type Task, type TaskStatus } from "@crane/contracts";
import type { Store } from "../store.js";
import type { Row } from "./rows.js";
import { now } from "./shared.js";

/** A commit a merged prerequisite put on the default branch. */
export interface LandedCommit {
  id: string;
  title: string;
  commit: string;
}

/** The task's prerequisites in the order it lists them, and whether each has landed. */
export function prerequisiteStates(store: Store, task: Pick<Task, "prerequisites">): PrerequisiteState[] {
  return task.prerequisites.map((id) => {
    const t = store.getTask(id);
    // A prerequisite that's gone can never land; it holds the task until the operator waives it.
    return t ? { id: t.id, title: t.title, status: t.status, met: prerequisiteMet(t) } : { id, title: "Unknown task", status: "failed", met: false };
  });
}

/**
 * What the task's merged prerequisites in this repo put on the default branch:
 * the commits a checkout must contain, and tasks whose record names no commit
 * (merged before Crane kept one). Prerequisites finished without a branch left
 * nothing to find, and a waiver means the operator accepted them being missing.
 */
export function prerequisiteCommits(
  store: Store,
  task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt" | "repoId">,
): { commits: LandedCommit[]; unrecorded: string[] } {
  const commits: LandedCommit[] = [];
  const unrecorded: string[] = [];
  if (task.prerequisitesWaivedAt) return { commits, unrecorded };
  for (const id of task.prerequisites) {
    const t = store.getTask(id);
    if (t?.status !== "merged" || t.repoId !== task.repoId) continue;
    const outcome = lastMergeOutcome(store.listEvents(t.id));
    const commit = outcome?.commit ?? outcome?.head;
    if (commit) commits.push({ id: t.id, title: t.title, commit });
    else unrecorded.push(t.id);
  }
  return { commits, unrecorded };
}

/** Prerequisites still holding the task back: not landed, and not waived by the operator. */
export function unmetPrerequisites(store: Store, task: Pick<Task, "prerequisites" | "prerequisitesWaivedAt">): PrerequisiteState[] {
  return task.prerequisitesWaivedAt ? [] : store.prerequisiteStates(task).filter((p) => !p.met);
}

/**
 * Let a queued task start without the prerequisites that haven't landed. One
 * conditional write, so it can't apply after the task has been picked up or
 * cancelled. Returns whether it applied.
 */
export function waivePrerequisites(store: Store, id: string): boolean {
  return store.db
    .prepare("UPDATE tasks SET prerequisites_waived_at = ? WHERE id = ? AND status = 'queued' AND prerequisites_waived_at IS NULL")
    .run(now(), id).changes > 0;
}

/** Tasks started from this task's findings, oldest first. */
export function followUps(store: Store, taskId: string): FollowUpState[] {
  return (store.db
    .prepare("SELECT id, title, status, follow_up_finding FROM tasks WHERE follow_up_of = ? ORDER BY created_at, rowid")
    .all(taskId) as Row[])
    .map((r) => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as TaskStatus,
      finding: (r.follow_up_finding as number) ?? null,
    }));
}

/** The task and finding this one was started from, or null when it isn't a follow-up. */
export function followUpSource(store: Store, task: Pick<Task, "followUpOf" | "followUpFinding">): FollowUpSource | null {
  if (!task.followUpOf) return null;
  const t = store.getTask(task.followUpOf);
  if (!t) return { id: task.followUpOf, title: "Unknown task", status: "failed", finding: null };
  const finding = task.followUpFinding === null ? undefined : t.report?.findings[task.followUpFinding];
  return { id: t.id, title: t.title, status: t.status, finding: finding?.title ?? null };
}
