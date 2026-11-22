import type Database from "better-sqlite3";
import {
  isDriverName, isRunnerOnline, RUNNER_LIMITS,
  type DriverName, type RunnerHeartbeat, type RunnerJobKind, type RunnerJobState, type RunnerResult, type RunnerSummary,
} from "@crane/contracts";
import { shortId } from "@crane/backend-runtime";
import type { Row } from "./rows.js";

/** A container as the factory reads it. Never carries its token or the token's digest. */
export type RunnerRecord = {
  id: string;
  operatorId: string;
  name: string;
  capacity: number;
  drivers: DriverName[];
  version: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};
export type NewRunner = { operatorId: string; name: string; tokenHash: string; capacity?: number; at: string };

/** A job posted to a container. `payload` is the dispatcher's brief for it, stored as JSON. */
export type RunnerJobRecord = {
  id: string;
  taskId: string;
  runnerId: string;
  kind: RunnerJobKind;
  payload: unknown;
  state: RunnerJobState;
  leaseExpiresAt: string | null;
  sessionId: string | null;
  result: RunnerResult | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
};
export type NewRunnerJob = { taskId: string; runnerId: string; kind: RunnerJobKind; payload: unknown; at: string };
/** The states a job can finish in. */
export type FinishedJobState = Exclude<RunnerJobState, "queued" | "claimed">;

/** Every column but token_hash, so nothing that reads a runner can hand its digest on. */
const RUNNER_COLUMNS = "r.id, r.operator_id, r.name, r.capacity, r.drivers, r.version, r.created_at, r.last_seen_at, r.revoked_at";
const OPEN = "state IN ('queued', 'claimed')";
const BUSY = "(SELECT COUNT(*) FROM runner_jobs j WHERE j.runner_id = r.id AND j.state = 'claimed') AS busy";

/** Stored driver lists are untrusted heartbeat input: keep only names this build knows. */
function storedDrivers(raw: unknown): DriverName[] {
  if (typeof raw !== "string") return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isDriverName) : [];
  } catch {
    return [];
  }
}

function toRunner(r: Row): RunnerRecord {
  return {
    id: r.id as string,
    operatorId: r.operator_id as string,
    name: r.name as string,
    capacity: r.capacity as number,
    drivers: storedDrivers(r.drivers),
    version: (r.version as string | null) ?? null,
    createdAt: r.created_at as string,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

function toSummary(r: Row, at: number): RunnerSummary {
  const runner = toRunner(r);
  return {
    id: runner.id, name: runner.name, ownerId: runner.operatorId, ownerName: r.owner_name as string,
    capacity: runner.capacity, drivers: runner.drivers, online: isRunnerOnline(runner.lastSeenAt, at),
    lastSeenAt: runner.lastSeenAt, createdAt: runner.createdAt, busy: r.busy as number,
  };
}

const json = (raw: unknown) => (typeof raw === "string" ? JSON.parse(raw) : null);

function toJob(r: Row): RunnerJobRecord {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    runnerId: r.runner_id as string,
    kind: r.kind as RunnerJobKind,
    payload: json(r.payload),
    state: r.state as RunnerJobState,
    leaseExpiresAt: (r.lease_expires_at as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    result: json(r.result) as RunnerResult | null,
    createdAt: r.created_at as string,
    claimedAt: (r.claimed_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

/** When a lease taken or renewed at `at` ends. */
export const leaseUntil = (at: string) => new Date(Date.parse(at) + RUNNER_LIMITS.leaseSeconds * 1000).toISOString();

/**
 * Containers and their jobs, reached through `store.runners`. Only digests of
 * container tokens reach the table, and only `byTokenHash` reads by one: no
 * method returns a token or its digest.
 */
export class RunnerStore {
  constructor(private readonly db: Database.Database) {}

  // Containers

  create(input: NewRunner): RunnerRecord {
    // `r-` is taken by repos; `c-` reads as container.
    const id = shortId("c");
    this.db.prepare(`INSERT INTO runners(id, operator_id, name, token_hash, capacity, created_at) VALUES(?, ?, ?, ?, ?, ?)`)
      .run(id, input.operatorId, input.name, input.tokenHash, input.capacity ?? 1, input.at);
    return this.byId(id)!;
  }

  /** The live container a token digest belongs to; a revoked one no longer signs in. */
  byTokenHash(tokenHash: string): RunnerRecord | null {
    const r = this.db.prepare(`SELECT ${RUNNER_COLUMNS} FROM runners r WHERE r.token_hash = ? AND r.revoked_at IS NULL`)
      .get(tokenHash) as Row | undefined;
    return r ? toRunner(r) : null;
  }

  /** Revoked ones too, so history can still name them. */
  byId(id: string): RunnerRecord | null {
    const r = this.db.prepare(`SELECT ${RUNNER_COLUMNS} FROM runners r WHERE r.id = ?`).get(id) as Row | undefined;
    return r ? toRunner(r) : null;
  }

  /** An operator's live containers, oldest first. */
  listFor(operatorId: string, at = Date.now()): RunnerSummary[] {
    return this.summaries("AND r.operator_id = ?", [operatorId], at);
  }

  /** Every live container, by owner then age. */
  listAll(at = Date.now()): RunnerSummary[] {
    return this.summaries("", [], at);
  }

  private summaries(where: string, params: string[], at: number): RunnerSummary[] {
    const rows = this.db.prepare(`SELECT ${RUNNER_COLUMNS}, o.name AS owner_name, ${BUSY}
      FROM runners r JOIN operators o ON o.id = r.operator_id
      WHERE r.revoked_at IS NULL ${where} ORDER BY o.username, r.created_at, r.id`).all(...params) as Row[];
    return rows.map((r) => toSummary(r, at));
  }

  /** Record a check-in; a heartbeat also records what the container can run now. */
  touch(id: string, at: string, heartbeat?: RunnerHeartbeat): boolean {
    if (!heartbeat) return this.db.prepare("UPDATE runners SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes > 0;
    const drivers = JSON.stringify(heartbeat.drivers.filter(isDriverName));
    return this.db.prepare(`UPDATE runners SET last_seen_at = ?, drivers = ?, version = ?, capacity = ?
      WHERE id = ? AND revoked_at IS NULL`).run(at, drivers, heartbeat.version, heartbeat.capacity, id).changes > 0;
  }

  setCapacity(id: string, capacity: number): boolean {
    return this.db.prepare("UPDATE runners SET capacity = ? WHERE id = ? AND revoked_at IS NULL").run(capacity, id).changes > 0;
  }

  rename(id: string, name: string): boolean {
    return this.db.prepare("UPDATE runners SET name = ? WHERE id = ? AND revoked_at IS NULL").run(name, id).changes > 0;
  }

  /** The old token stops working at once. */
  rotateToken(id: string, tokenHash: string): boolean {
    return this.db.prepare("UPDATE runners SET token_hash = ? WHERE id = ? AND revoked_at IS NULL").run(tokenHash, id).changes > 0;
  }

  /** Its token stops working and its open jobs are cancelled; the record stays for history. */
  revoke(id: string, at: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE runners SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes > 0;
      if (changed) this.cancelOpenJobs("runner_id = ?", id, at);
      return changed;
    }).immediate();
  }

  /** Its open jobs are cancelled; finished ones stay with their tasks. */
  remove(id: string, at: string): boolean {
    return this.db.transaction(() => {
      this.cancelOpenJobs("runner_id = ?", id, at);
      return this.db.prepare("DELETE FROM runners WHERE id = ?").run(id).changes > 0;
    }).immediate();
  }

  // Jobs

  createJob(input: NewRunnerJob): RunnerJobRecord {
    const id = shortId("j", 8);
    this.db.prepare(`INSERT INTO runner_jobs(id, task_id, runner_id, kind, payload, state, created_at)
      VALUES(?, ?, ?, ?, ?, 'queued', ?)`).run(id, input.taskId, input.runnerId, input.kind, JSON.stringify(input.payload), input.at);
    return this.job(id)!;
  }

  job(id: string): RunnerJobRecord | null {
    const r = this.db.prepare("SELECT * FROM runner_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  /**
   * Lease the container's oldest queued job, while it has capacity and isn't
   * revoked. Immediate, so two claims from the same container never take the
   * same job or more than its capacity.
   */
  claimJob(runnerId: string, at: string): RunnerJobRecord | null {
    return this.db.transaction(() => {
      const room = this.db.prepare(`SELECT 1 FROM runners r WHERE r.id = ? AND r.revoked_at IS NULL
        AND (SELECT COUNT(*) FROM runner_jobs j WHERE j.runner_id = r.id AND j.state = 'claimed') < r.capacity`).get(runnerId);
      if (!room) return null;
      const next = this.db.prepare(`SELECT id FROM runner_jobs WHERE runner_id = ? AND state = 'queued'
        ORDER BY created_at, rowid LIMIT 1`).get(runnerId) as Row | undefined;
      if (!next) return null;
      this.db.prepare(`UPDATE runner_jobs SET state = 'claimed', claimed_at = ?, lease_expires_at = ?
        WHERE id = ? AND state = 'queued'`).run(at, leaseUntil(at), next.id);
      return this.job(next.id as string);
    }).immediate();
  }

  /** Renew a claimed job's lease from `at`. False once it is no longer claimed, or not by `runnerId`. */
  extendLease(id: string, runnerId: string, at: string): boolean {
    return this.db.prepare(`UPDATE runner_jobs SET lease_expires_at = ? WHERE id = ? AND runner_id = ? AND state = 'claimed'`)
      .run(leaseUntil(at), id, runnerId).changes > 0;
  }

  /** The agent session a claimed job started, so a later run can resume it. */
  recordSession(id: string, sessionId: string): boolean {
    return this.db.prepare(`UPDATE runner_jobs SET session_id = ? WHERE id = ? AND state = 'claimed'`).run(sessionId, id).changes > 0;
  }

  /** Close an open job. False if it had already finished, so only one outcome is ever recorded. */
  finishJob(id: string, state: FinishedJobState, result: RunnerResult | null, at = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE runner_jobs SET state = ?, result = ?, finished_at = ?, lease_expires_at = NULL
      WHERE id = ? AND ${OPEN}`).run(state, result ? JSON.stringify(result) : null, at, id).changes > 0;
  }

  /** The task's queued or claimed job, if any. */
  openJobFor(taskId: string): RunnerJobRecord | null {
    const r = this.db.prepare(`SELECT * FROM runner_jobs WHERE task_id = ? AND ${OPEN} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(taskId) as Row | undefined;
    return r ? toJob(r) : null;
  }

  /** Cancel the task's open jobs; returns how many. */
  cancelJobsFor(taskId: string, at = new Date().toISOString()): number {
    return this.cancelOpenJobs("task_id = ?", taskId, at);
  }

  /** Expire claimed jobs whose lease ended at or before `now`, returning them so their tasks can be handed back. */
  expireLeases(now: string): RunnerJobRecord[] {
    const rows = this.db.prepare(`UPDATE runner_jobs SET state = 'expired', finished_at = ?, lease_expires_at = NULL
      WHERE state = 'claimed' AND lease_expires_at <= ? RETURNING *`).all(now, now) as Row[];
    return rows.map(toJob);
  }

  private cancelOpenJobs(where: string, value: string, at: string): number {
    return this.db.prepare(`UPDATE runner_jobs SET state = 'cancelled', finished_at = ?, lease_expires_at = NULL
      WHERE ${where} AND ${OPEN}`).run(at, value).changes;
  }
}
