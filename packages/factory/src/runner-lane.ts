import { existsSync } from "node:fs";
import { runnerLabel, type RunnerSummary } from "@crane/contracts";
import type { RunnerJobRecord, Store } from "@crane/storage";
import { incomingBundlePath } from "./remote/paths.js";
import type { CrewMember } from "./work-run.js";

/**
 * Container lanes. Each container works its own routed tasks, as many at once
 * as its capacity, in lane slots that are not crew: they have no `agents` row,
 * no crew settings and never take one of the factory's crew slots.
 */

/** Lane member ids start with this; crew ids start with `a-`. */
const LANE_PREFIX = "r-";

/** Whether an agent id names a container lane slot rather than a crew member. */
export const isLaneMember = (agentId: string | null | undefined): boolean => !!agentId?.startsWith(LANE_PREFIX);

/** One container's lane slots, one per job it may run at once. */
export function laneMembers(runner: RunnerSummary): CrewMember[] {
  const name = runnerLabel(runner);
  return Array.from({ length: Math.max(0, runner.capacity) }, (_, slot) => ({ id: `${LANE_PREFIX}${runner.id}-${slot}`, name }));
}

/** Whether a job kind is a task's own run, which may outlive the factory that sent it. */
const ownRun = (job: RunnerJobRecord) => job.kind === "work" || job.kind === "observe";

/**
 * The task's own job that a container still holds a lease on at `now`: the
 * container is working it, so the task stays running for the lane to wait on
 * again rather than going back in the queue and being sent twice.
 */
export function liveLease(store: Store, taskId: string, now = Date.now()): RunnerJobRecord | null {
  const job = store.runners.openJobFor(taskId);
  if (!job || job.state !== "claimed" || !ownRun(job) || !job.leaseExpiresAt) return null;
  return Date.parse(job.leaseExpiresAt) > now ? job : null;
}

/**
 * The task's newest job when it is a work job its container returned with
 * commits that no factory has applied yet: the container finished while
 * nobody waited on it, so the next run applies the bundle instead of sending
 * the work again. Applying (or refusing) a bundle removes it, so one still
 * there was never taken.
 */
export function waitingReturn(store: Store, taskId: string): RunnerJobRecord | null {
  const job = store.runners.latestJobFor(taskId);
  if (!job || job.state !== "returned" || job.kind !== "work") return null;
  return existsSync(incomingBundlePath(job.id)) ? job : null;
}

/** The task's own job a container is working, or has returned for this factory to apply. */
export function keptJob(store: Store, taskId: string, now = Date.now()): RunnerJobRecord | null {
  return liveLease(store, taskId, now) ?? waitingReturn(store, taskId);
}
