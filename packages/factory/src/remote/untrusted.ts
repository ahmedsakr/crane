import {
  isDriverName,
  RUNNER_EVENT_TYPES,
  RUNNER_LIMITS,
  type RunnerEventType,
  type RunnerHeartbeat,
  type RunnerResult,
  type RunUsage,
} from "@crane/contracts";
import { checkRunnerCapacity } from "../action-inputs.js";

/**
 * Everything a container sends is untrusted. These turn its JSON into the
 * shapes Crane stores, dropping what doesn't fit and capping sizes. None of
 * them throws on a malformed event: a bad event is dropped, not the batch.
 */

/** Longest final message kept from a container. Reports are parsed from it, so it is generous. */
export const FINAL_TEXT_CHARS = 512 * 1024;
/** Event data larger than this, as JSON, is dropped and the event kept without it. */
export const EVENT_DATA_CHARS = 16 * 1024;
const ERROR_CHARS = 4000;
const SESSION_CHARS = 200;
const VERSION_CHARS = 64;

/**
 * Event data keys whose meaning belongs to Crane: operator attribution, check
 * results, merge outcomes, retention and schedule markers. A container can't
 * set them, so its events never read as Crane's own.
 */
const CRANE_DATA_KEYS = new Set(["actor", "validation", "merge", "retention", "scheduleId", "hold", "runnerJob"]);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

export type AcceptedEvent = { type: RunnerEventType; message: string; data: Record<string, unknown> };

function eventData(raw: unknown, jobId: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) if (!CRANE_DATA_KEYS.has(key)) data[key] = value;
  }
  let size = Infinity;
  try {
    size = JSON.stringify(data).length;
  } catch {
    // Not serializable, so it can't be stored.
  }
  return size <= EVENT_DATA_CHARS ? { ...data, runnerJob: jobId } : { runnerJob: jobId, truncated: true };
}

/** The events of a batch Crane accepts: allowed types only, at most `eventsPerBatch`, messages cut to size. */
export function acceptedEvents(batch: unknown, jobId: string): AcceptedEvent[] {
  const events = isRecord(batch) && Array.isArray(batch.events) ? batch.events : [];
  const accepted: AcceptedEvent[] = [];
  for (const raw of events.slice(0, RUNNER_LIMITS.eventsPerBatch)) {
    if (!isRecord(raw) || !(RUNNER_EVENT_TYPES as readonly unknown[]).includes(raw.type)) continue;
    const message = text(raw.message, RUNNER_LIMITS.eventMessageChars);
    if (message === null) continue;
    accepted.push({ type: raw.type as RunnerEventType, message, data: eventData(raw.data, jobId) });
  }
  return accepted;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** What a run used, as Crane records it, or null when the container sent nothing usable. */
export function acceptedUsage(raw: unknown): RunUsage | null {
  if (!isRecord(raw)) return null;
  const status = raw.costStatus;
  return {
    costUsd: count(raw.costUsd),
    ...(status === "reported" || status === "estimated" || status === "unknown" ? { costStatus: status } : {}),
    inputTokens: Math.round(count(raw.inputTokens)),
    outputTokens: Math.round(count(raw.outputTokens)),
    cacheReadTokens: Math.round(count(raw.cacheReadTokens)),
    cacheWriteTokens: Math.round(count(raw.cacheWriteTokens)),
    turns: Math.round(count(raw.turns)),
    model: text(raw.model, 200),
  };
}

/** A session id as a resume argument would take it: short, printable, no spaces. */
export function acceptedSession(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(raw) ? raw.slice(0, SESSION_CHARS) : null;
}

/** How a job ended, as Crane stores it. Throws when the outcome itself is missing. */
export function acceptedResult(raw: unknown): RunnerResult {
  if (!isRecord(raw) || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
    throw new Error("Say whether the job succeeded or failed");
  }
  const result: RunnerResult = { outcome: raw.outcome };
  const finalText = text(raw.finalText, FINAL_TEXT_CHARS);
  if (finalText !== null) result.finalText = finalText;
  if (isRecord(raw.error)) {
    result.error = {
      message: text(raw.error.message, ERROR_CHARS) || "The container's agent failed",
      transient: raw.error.transient === true,
      ...(raw.error.limit === "turns" ? { limit: "turns" as const } : {}),
    };
  }
  const sessionId = acceptedSession(raw.sessionId);
  if (sessionId) result.sessionId = sessionId;
  const usage = acceptedUsage(raw.usage);
  if (usage) result.usage = usage;
  return result;
}

/** A heartbeat with only the drivers this build knows and a capacity Crane allows. Throws when it can't be read. */
export function acceptedHeartbeat(raw: unknown): RunnerHeartbeat & { jobs: string[] } {
  if (!isRecord(raw)) throw new Error("Send a heartbeat with the container's drivers, capacity and version");
  const drivers = Array.isArray(raw.drivers) ? [...new Set(raw.drivers.filter(isDriverName))] : [];
  const jobs = Array.isArray(raw.jobs)
    ? [...new Set(raw.jobs.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9-]{1,40}$/.test(id)))].slice(0, 64)
    : [];
  return {
    drivers,
    capacity: checkRunnerCapacity(raw.capacity),
    version: text(raw.version, VERSION_CHARS)?.replace(/\p{Cc}/gu, "") || "unknown",
    jobs,
  };
}
