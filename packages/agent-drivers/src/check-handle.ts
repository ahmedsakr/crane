/**
 * Crane's check handle, run by agents as `node <dist>/check-handle.js`.
 *
 *   run <name> -- <command...>   run a check, logging to .crane/checks/<name>.log,
 *                                record its exit code in <name>.json, and exit with it
 *   wait <name> [--timeout <s>]  wait up to 300 s (at most 540) for that check, then
 *                                exit with its exit code, 75 if it is still running,
 *                                or 70 if its runner stopped without a result
 *
 * Claude Code's Bash tool reports no process exit code, so agents that ran
 * checks in the background polled log files and guessed. The record written
 * here is what the driver reads back (`check-results.ts`). Node modules only.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import {
  CHECK_NAME, LOST_EXIT, STILL_RUNNING_EXIT, describeOutcome, ensureChecksDir, readCheckRecord, writeCheckRecord,
  type CheckRecord,
} from "./check-results.js";

const USAGE_EXIT = 64;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 540;
/** How long `wait` lets a just-launched `run` take to write its first record. */
const START_GRACE_MS = 10_000;

function usage(message: string): never {
  process.stderr.write(`crane-check: ${message}\nUsage: run <name> -- <command...> | wait <name> [--timeout <seconds>]\n`);
  process.exit(USAGE_EXIT);
}

function tail(path: string, lines: number): string {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 8192);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    return buffer.toString("utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function elapsed(record: CheckRecord, until = Date.now()): string {
  return `${((until - Date.parse(record.startedAt)) / 1000).toFixed(1)}s`;
}

function printResult(record: CheckRecord): void {
  const output = tail(record.log, 20);
  if (output) process.stdout.write(`${output}\n\n`);
  const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  process.stdout.write(`crane-check ${record.name}: ${describeOutcome(record)} after ${elapsed(record, end)}; full log ${record.log}\n`);
}

function exitStatus(record: CheckRecord): number {
  if (record.exitCode !== null) return record.exitCode;
  const signal = record.signal ? constants.signals[record.signal as NodeJS.Signals] : undefined;
  return signal ? 128 + signal : 1;
}

function run(name: string, argv: string[]): void {
  const command = argv.join(" ").trim();
  if (!command) usage("run needs a command after --");
  const dir = ensureChecksDir(process.cwd());
  const log = join(dir, `${name}.log`);
  const fd = openSync(log, "w");
  const record: CheckRecord = {
    name, command, pid: process.pid, status: "running", exitCode: null, signal: null,
    startedAt: new Date().toISOString(), finishedAt: null, log,
  };
  writeCheckRecord(dir, record);
  const child = spawn(command, { shell: true, stdio: ["ignore", fd, fd] });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  let done = false;
  const finish = (exitCode: number | null, signal: string | null) => {
    if (done) return;
    done = true;
    closeSync(fd);
    const status = exitCode === 0 ? "passed" : "failed";
    const final: CheckRecord = { ...record, status, exitCode, signal, finishedAt: new Date().toISOString() };
    writeCheckRecord(dir, final);
    printResult(final);
    process.exit(exitStatus(final));
  };
  child.on("error", (error) => {
    process.stderr.write(`crane-check: couldn't start ${name}: ${error.message}\n`);
    finish(127, null);
  });
  child.on("exit", (code, signal) => finish(code, signal));
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitSeconds(args: string[]): number {
  const index = args.indexOf("--timeout");
  if (index < 0) return DEFAULT_WAIT_SECONDS;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) usage("--timeout needs a number of seconds");
  return Math.min(value, MAX_WAIT_SECONDS);
}

function progress(record: CheckRecord): string {
  const size = statSync(record.log, { throwIfNoEntry: false })?.size ?? 0;
  const last = tail(record.log, 1);
  return `crane-check ${record.name}: still running after ${elapsed(record)} (log ${size} bytes${last ? `, last line: ${last.slice(0, 200)}` : ""})`;
}

async function wait(name: string, seconds: number): Promise<void> {
  const dir = ensureChecksDir(process.cwd());
  const started = Date.now();
  const deadline = started + seconds * 1000;
  let reported = started;
  for (;;) {
    const record = readCheckRecord(dir, name);
    if (record && record.status !== "running") {
      printResult(record);
      process.exit(exitStatus(record));
    }
    if (record && !alive(record.pid)) {
      process.stdout.write(`crane-check ${name}: its runner stopped without recording a result; the outcome is unknown. Log ${record.log}\n`);
      process.exit(LOST_EXIT);
    }
    if (!record && Date.now() - started > START_GRACE_MS) usage(`no check named ${name} has started in ${dir}`);
    if (record && Date.now() >= deadline) {
      process.stdout.write(`${progress(record)}. Run wait again for the result.\n`);
      process.exit(STILL_RUNNING_EXIT);
    }
    if (record && Date.now() - reported >= 30_000) {
      reported = Date.now();
      process.stdout.write(`${progress(record)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function main(argv: string[]): void {
  const [action, name, ...rest] = argv;
  if (!name || !CHECK_NAME.test(name)) usage("give the check a name of letters, digits, dots, dashes or underscores");
  if (action === "run") {
    if (rest[0] !== "--") usage("put -- before the check's command");
    run(name, rest.slice(1));
  } else if (action === "wait") {
    void wait(name, waitSeconds(rest));
  } else {
    usage(`unknown action ${action ?? ""}`);
  }
}

main(process.argv.slice(2));
