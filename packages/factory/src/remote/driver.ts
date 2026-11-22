import { driverLabel, isRunnerOnline, runnerLabel, RUNNER_LIMITS, type DriverName } from "@crane/contracts";
import { AgentRunError, parseReport, type AgentDriver, type RunContext, type RunResult } from "@crane/agent-protocol";
import type { RunnerJobRecord, RunnerRecord, Store } from "@crane/storage";
import { sleep } from "../run-limits.js";
import { BundleRefused, discardIncoming, materialize } from "./materialize.js";
import { jobPayload, type JobPayload } from "./payload.js";
import { uploadedScreenshots } from "./screenshots.js";

export interface RemoteDriverOptions {
  /** How often the job's row is read while the container works. */
  pollMs?: number;
  /** What time Crane thinks it is; tests move it to reach lease expiry and offline. */
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Runs an agent on an operator's container instead of here. Each run becomes a
 * `runner_jobs` row the container claims; this waits on that row, because the
 * store is the only truth shared with the API process the container talks to.
 * Built per (container, agent), and named after the agent, so the runs ledger
 * and session ownership read as they do for a local run.
 */
export class RemoteDriver implements AgentDriver {
  readonly label: string;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly store: Store, private readonly runnerId: string, readonly name: DriverName, opts: RemoteDriverOptions = {}) {
    this.label = `${driverLabel(name)} on a container`;
    this.pollMs = opts.pollMs ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  /** A container that's offline is still worth sending to: `run` says why if it never answers. */
  async available(): Promise<boolean> {
    const runner = this.store.runners.byId(this.runnerId);
    return !!runner && !runner.revokedAt;
  }

  async run(ctx: RunContext): Promise<RunResult> {
    const runner = this.liveRunner();
    const label = this.labelFor(runner);
    if (isRunnerOnline(runner.lastSeenAt, this.now()) && runner.drivers.length && !runner.drivers.includes(this.name)) {
      throw new AgentRunError(`${driverLabel(this.name)} isn't signed in on ${label}. Sign in there, or choose another agent`);
    }
    if (ctx.signal.aborted) throw new AgentRunError("Stopped before the job was sent");
    const payload = await jobPayload(ctx, this.name);
    const job = this.store.runners.createJob({ taskId: ctx.task.id, runnerId: runner.id, kind: payload.kind, payload, at: iso(this.now()) });
    ctx.emit("note", `Sent to ${label}`, { runnerJob: job.id });
    const done = await this.waitFor(job.id, ctx, label);
    return this.finish(done, ctx, payload, label);
  }

  private liveRunner(): RunnerRecord {
    const runner = this.store.runners.byId(this.runnerId);
    if (!runner || runner.revokedAt) throw new AgentRunError("This task's container was removed. Choose another container, then retry it");
    return runner;
  }

  private labelFor(runner: RunnerRecord): string {
    return runnerLabel({ name: runner.name, ownerName: this.store.access.operatorById(runner.operatorId)?.name ?? "An operator" });
  }

  /** Wait until the job ends. An abort (cancelled task, stopping factory) cancels it, so the container hears to stop. */
  private async waitFor(jobId: string, ctx: RunContext, label: string): Promise<RunnerJobRecord> {
    const cancel = () => {
      try {
        this.store.runners.finishJob(jobId, "cancelled", null, iso(this.now()));
      } catch {
        // The loop below tries again; a store closing under a stopping factory is all this can hit.
      }
    };
    ctx.signal.addEventListener("abort", cancel, { once: true });
    let session: string | null = null;
    try {
      for (;;) {
        if (ctx.signal.aborted) {
          cancel();
          throw new AgentRunError(`Stopped, so ${label} was told to stop`);
        }
        const job = this.store.runners.job(jobId);
        if (!job) throw new AgentRunError(`${label}'s job is gone`);
        if (job.sessionId && job.sessionId !== session) ctx.onSession?.(session = job.sessionId);
        if (this.settled(job, label)) return job;
        await sleep(this.pollMs, ctx.signal).catch(() => undefined);
      }
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
  }

  /** Whether the job has its result. Throws when it ended without one, or should be given up on. */
  private settled(job: RunnerJobRecord, label: string): boolean {
    const now = this.now();
    const transient = (message: string) => new AgentRunError(message, { transient: true, sessionId: job.sessionId });
    switch (job.state) {
      case "returned":
      case "failed":
        return true;
      case "expired":
        throw transient(`${label} stopped answering, so its job expired`);
      case "cancelled":
        throw new AgentRunError(`${label}'s job was cancelled`, { sessionId: job.sessionId });
      case "claimed":
        if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now && this.expire(job)) {
          throw transient(`${label} stopped answering, so its job expired`);
        }
        return false;
      case "queued": {
        const runner = this.store.runners.byId(job.runnerId);
        const waited = now - Date.parse(job.createdAt) > RUNNER_LIMITS.offlineAfterSeconds * 1000;
        if (waited && !isRunnerOnline(runner?.lastSeenAt ?? null, now) && this.expire(job)) {
          throw transient(`${label} is offline, so it didn't pick up this job`);
        }
        return false;
      }
    }
  }

  /** Expire the job unless it finished meanwhile; true when this call ended it. */
  private expire(job: RunnerJobRecord): boolean {
    return this.store.runners.finishJob(job.id, "expired", null, iso(this.now()));
  }

  /** Record what the job used, then bring its work into Crane's directory and parse its report. */
  private async finish(job: RunnerJobRecord, ctx: RunContext, payload: JobPayload, label: string): Promise<RunResult> {
    const result = job.result;
    if (result?.usage) ctx.onUsage?.(result.usage);
    if (result?.sessionId && result.sessionId !== job.sessionId) ctx.onSession?.(result.sessionId);
    const sessionId = result?.sessionId ?? job.sessionId;
    if (job.state !== "returned" || result?.outcome !== "succeeded") {
      discardIncoming(job.id);
      const error = result?.error;
      throw new AgentRunError(`${label}: ${error?.message ?? "the agent failed"}`, { transient: !!error?.transient, sessionId, ...(error?.limit ? { limit: error.limit } : {}) });
    }
    try {
      await materialize({ id: job.id, kind: job.kind, cwd: ctx.cwd, start: payload.tip ?? payload.base, branch: payload.branch });
    } catch (err) {
      if (!(err instanceof BundleRefused)) throw err;
      ctx.emit("note", `Refused the commits ${label} returned: ${err.message}. Crane's worktree is unchanged`, { runnerJob: job.id, refused: true });
      throw new AgentRunError(`Crane refused what ${label} returned: ${err.message}`, { sessionId });
    }
    // Parsed here from the raw text, like a local run; validation never comes from the container.
    const report = parseReport(result.finalText ?? "");
    delete report.validation;
    const screenshots = uploadedScreenshots(job.taskId, job.id, report.screenshots);
    if (screenshots) report.screenshots = screenshots;
    return { report };
  }
}
