import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What Crane's check handle (`check-handle.ts`) and the Claude driver agree on.
 * The handle runs a check and writes one record per check name under the
 * worktree's `.crane/checks/`, so a check's exit code survives the Bash tool,
 * which reports none (see `claude-evidence.ts`).
 */
export const CHECKS_DIR = join(".crane", "checks");

/** `wait` exits with this when the check is still running at its deadline. */
export const STILL_RUNNING_EXIT = 75;
/** `wait` exits with this when the check's runner stopped without a result. */
export const LOST_EXIT = 70;

export const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CheckRecord {
  name: string;
  command: string;
  /** The runner's pid, so `wait` can tell a running check from a lost one. */
  pid: number;
  status: "running" | "passed" | "failed";
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string | null;
  log: string;
}

export function checksDir(root: string): string {
  return join(root, CHECKS_DIR);
}

/** Creates the directory with a `.gitignore` of its own, so records never get committed. */
export function ensureChecksDir(root: string): string {
  const dir = checksDir(root);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

/** Written to a temporary file and renamed, so a reader never sees half a record. */
export function writeCheckRecord(dir: string, record: CheckRecord): void {
  const path = join(dir, `${record.name}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record, null, 2) + "\n");
  renameSync(temp, path);
}

function parseRecord(text: string): CheckRecord | null {
  try {
    const value = JSON.parse(text) as Partial<CheckRecord>;
    if (typeof value.name !== "string" || typeof value.command !== "string" || typeof value.startedAt !== "string") return null;
    if (!["running", "passed", "failed"].includes(String(value.status))) return null;
    const exitCode = typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
    return {
      name: value.name, command: value.command, pid: Number(value.pid) || 0,
      status: value.status as CheckRecord["status"], exitCode,
      signal: typeof value.signal === "string" ? value.signal : null,
      startedAt: value.startedAt, finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
      log: typeof value.log === "string" ? value.log : "",
    };
  } catch {
    return null;
  }
}

export function readCheckRecord(dir: string, name: string): CheckRecord | null {
  try {
    return parseRecord(readFileSync(join(dir, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Records of checks started at or after `since`, oldest first, at most `limit` of them. */
export function checkRecordsSince(root: string, since: Date, limit = 20): CheckRecord[] {
  const dir = checksDir(root);
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const records: CheckRecord[] = [];
  for (const file of files) {
    const info = statSync(join(dir, file), { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > 65536) continue;
    const record = readCheckRecord(dir, file.slice(0, -".json".length));
    if (record && Date.parse(record.startedAt) >= since.getTime()) records.push(record);
  }
  return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-limit);
}

export function describeOutcome(record: CheckRecord): string {
  if (record.status === "running") return "still running, no exit code recorded";
  if (record.exitCode !== null) return `${record.status} (exit ${record.exitCode})`;
  return `${record.status} (signal ${record.signal ?? "unknown"}, no exit code)`;
}
