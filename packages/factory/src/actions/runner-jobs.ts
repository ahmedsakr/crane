import { renameSync, rmSync, writeFileSync } from "node:fs";
import { RUNNER_LIMITS, type RunnerHeartbeatReply, type RunnerJob } from "@crane/contracts";
import type { RunnerJobRecord, RunnerRecord } from "@crane/storage";
import { bundleFor, type OutgoingBundle } from "../remote/bundle.js";
import { incomingBundlePath } from "../remote/paths.js";
import type { JobPayload } from "../remote/payload.js";
import { saveJobScreenshot } from "../remote/screenshots.js";
import { acceptedEvents, acceptedHeartbeat, acceptedResult, acceptedSession } from "../remote/untrusted.js";
import { AccessError } from "./access-errors.js";
import { iso, type AccessDeps } from "./access-rules.js";

/**
 * What an authenticated container does with its jobs. Every call names the
 * container the API signed in, and touches only jobs leased to it. What it
 * sends is untrusted and goes through `remote/untrusted.ts` first.
 */

const NOT_YOURS = "This job isn't leased to this container";
const MB = 1024 * 1024;

/** The job, if it belongs to `runner`. Others' jobs read the same as missing ones. */
function ownJob({ store }: AccessDeps, runner: RunnerRecord, jobId: unknown): RunnerJobRecord {
  const job = typeof jobId === "string" ? store.runners.job(jobId) : null;
  if (!job || job.runnerId !== runner.id) throw new AccessError(403, NOT_YOURS);
  return job;
}

/** The job, while the container still holds its lease. */
function leasedJob(deps: AccessDeps, runner: RunnerRecord, jobId: unknown): RunnerJobRecord {
  const job = ownJob(deps, runner, jobId);
  if (job.state !== "claimed") throw new Error("This job is no longer running");
  return job;
}

/** Lease the container's next job, as the brief it works from. */
export function claimRunnerJob(deps: AccessDeps, runner: RunnerRecord): RunnerJob | null {
  const job = deps.store.runners.claimJob(runner.id, iso(deps.now()));
  if (!job) return null;
  return { ...(job.payload as JobPayload), id: job.id, kind: job.kind, taskId: job.taskId, leaseExpiresAt: job.leaseExpiresAt! };
}

/** Record the check-in and renew the leases of the jobs it runs. Any it shouldn't run come back to stop. */
export function runnerHeartbeat(deps: AccessDeps, runner: RunnerRecord, input: unknown): RunnerHeartbeatReply {
  const heartbeat = acceptedHeartbeat(input);
  const { store } = deps;
  return store.transaction(() => {
    const at = iso(deps.now());
    store.runners.touch(runner.id, at, heartbeat);
    const cancel = heartbeat.jobs.filter((id) => !store.runners.extendLease(id, runner.id, at));
    return { cancel };
  }, { immediate: true });
}

/** Add the container's events to the task's activity: allowed types only, within the size caps. */
export function appendJobEvents(deps: AccessDeps, runner: RunnerRecord, jobId: unknown, batch: unknown): { accepted: number } {
  const { store } = deps;
  return store.transaction(() => {
    const job = leasedJob(deps, runner, jobId);
    const events = acceptedEvents(batch, job.id);
    for (const e of events) store.addEvent(job.taskId, e.type, e.message, e.data);
    return { accepted: events.length };
  }, { immediate: true });
}

/** The agent session the job started, so the task can resume it later. */
export function recordJobSession(deps: AccessDeps, runner: RunnerRecord, jobId: unknown, sessionId: unknown): void {
  const session = acceptedSession(sessionId);
  if (!session) throw new Error("Send the agent's session id");
  const job = leasedJob(deps, runner, jobId);
  if (!deps.store.runners.recordSession(job.id, session)) throw new Error("This job is no longer running");
}

/** Keep one screenshot in the task's worktree. Returns the path the job's report should name. */
export function storeJobScreenshot(deps: AccessDeps, runner: RunnerRecord, jobId: unknown, name: unknown, bytes: Uint8Array): { path: string } {
  const job = leasedJob(deps, runner, jobId);
  if (job.kind === "observe") throw new Error("Investigate-only jobs can't attach screenshots");
  return { path: saveJobScreenshot(job.taskId, job.id, name, bytes) };
}

/** An oversized bundle fails the job here, with a note on the task, before anything is written. */
function refuseOversized(deps: AccessDeps, job: RunnerJobRecord, bytes: number): never {
  const message = `The container returned ${Math.ceil(bytes / MB)} MB of commits, more than the ${RUNNER_LIMITS.bundleBytes / MB} MB Crane accepts`;
  deps.store.transaction(() => {
    if (deps.store.runners.finishJob(job.id, "failed", { outcome: "failed", error: { message, transient: false } }, iso(deps.now()))) {
      deps.store.addEvent(job.taskId, "note", `Refused the container's commits: ${message}. Crane's worktree is unchanged`, { runnerJob: job.id, refused: true });
    }
  }, { immediate: true });
  throw new Error(message);
}

/**
 * Finish the job with its result and, for work and merge jobs, the bundle of
 * its commits. The factory running the job checks and applies the bundle;
 * nothing here touches a worktree.
 */
export function returnJob(deps: AccessDeps, runner: RunnerRecord, jobId: unknown, input: unknown, bundle?: Uint8Array | null): void {
  const job = leasedJob(deps, runner, jobId);
  const result = acceptedResult(input);
  let path: string | null = null;
  if (bundle) {
    if (job.kind === "observe") throw new Error("Investigate-only jobs return no commits");
    if (bundle.byteLength > RUNNER_LIMITS.bundleBytes) refuseOversized(deps, job, bundle.byteLength);
    path = incomingBundlePath(job.id);
    // Written in full before the job reads as returned, so the factory never sees half a bundle.
    writeFileSync(`${path}.part`, bundle);
    renameSync(`${path}.part`, path);
  }
  const state = result.outcome === "succeeded" ? "returned" : "failed";
  if (!deps.store.runners.finishJob(job.id, state, result, iso(deps.now()))) {
    if (path) rmSync(path, { force: true });
    throw new Error("This job is no longer running");
  }
}

/** The commits a claimed job needs, less what the container says it has. Null when it has them all. */
export async function jobBundle(deps: AccessDeps, runner: RunnerRecord, jobId: unknown, have?: unknown): Promise<OutgoingBundle | null> {
  return bundleFor(deps.store, leasedJob(deps, runner, jobId), have);
}
