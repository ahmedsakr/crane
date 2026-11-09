import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TEST_GROUPS } from "./test-groups.ts";
import { rootSuites, suiteCatalog } from "./test-ownership.ts";
import { nxEntry, nxEnvironment } from "./tasks.ts";

/**
 * Times Crane's public task commands over fixed, repeatable workloads, so the backend
 * extraction can be compared with the same edits before and after. Every run records a
 * monotonic duration, the wall-clock duration, the process's own exit code or signal,
 * the load average and an unfiltered log. It never changes configured checks and never
 * caches tests: it only runs `npm run typecheck`, `npm test` and the affected commands.
 * See docs/backend-extraction.md#benchmark-protocol.
 */

export interface BenchCase {
  id: string;
  boundary: string;
  /** The file a probe export is appended to; small files keep code-shape limits safe. */
  file: string;
  /** Focus cases carry the acceptance target and run the full repetition count. */
  focus: boolean;
}

export const CASES: readonly BenchCase[] = [
  { id: "cli", boundary: "CLI-only", file: "src/cli/ui.ts", focus: true },
  { id: "http", boundary: "HTTP-only", file: "src/server/body.ts", focus: true },
  { id: "factory", boundary: "factory-only", file: "src/factory/elapsed.ts", focus: false },
  { id: "storage", boundary: "storage-only", file: "src/core/store/shared.ts", focus: false },
  { id: "runtime", boundary: "runtime-only", file: "packages/backend-runtime/src/ids.ts", focus: false },
  { id: "web", boundary: "web-only", file: "web/src/lib/format.ts", focus: false },
  { id: "contracts", boundary: "shared-contract", file: "packages/contracts/src/errors.ts", focus: false },
];

export type Phase = "cold" | "warm" | "uncached" | "changed" | "changed-uncached";
export type Workload = "typecheck" | "test" | "affected:typecheck" | "affected:test";

export interface Measurement {
  workload: Workload;
  phase: Phase;
  caseId: string | null;
  rep: number;
  command: string;
  exitCode: number | null;
  signal: string | null;
  monotonicSeconds: number;
  wallSeconds: number;
  load: number[];
  nxCache: { hits: number; total: number } | null;
  tests: Record<string, number>;
  log: string;
}

export interface Options {
  root: string;
  out: string;
  phases: Set<string>;
  reps: number;
  secondaryReps: number;
  cases: readonly BenchCase[];
}

/** A valid export unique to one run, so no run can replay another's cache entry. */
export function probeText(token: string): string {
  return `\nexport const craneBenchmarkProbe = ${JSON.stringify(token)};\n`;
}

/** Appends the probe and returns a function that restores the file's exact bytes. */
export function applyProbe(root: string, file: string, token: string): () => void {
  const path = join(root, file);
  const original = readFileSync(path);
  appendFileSync(path, probeText(token));
  return () => writeFileSync(path, original);
}

export function median(values: readonly number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nx's own cache summary (Nx 24's `Cache: 9/15 hit`, or the older sentence), absent when Nx didn't run. */
export function parseNxCache(log: string): { hits: number; total: number } | null {
  const match = /Cache:\s+(\d+)\/(\d+) hit/.exec(log)
    ?? /read the output from the cache instead of running the command for (\d+) out of (\d+) tasks/.exec(log);
  return match ? { hits: Number(match[1]), total: Number(match[2]) } : null;
}

/** The node:test summary counts, from either the TAP (`# tests 5`) or spec (`ℹ tests 5`) reporter. */
export function parseTestCounts(log: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of log.matchAll(/^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
    counts[match[1]!] = Number(match[2]);
  }
  return counts;
}

export function npmArgs(workload: Workload, list = false): string[] {
  if (workload === "typecheck" || workload === "test") return ["run", workload];
  const args = ["run", ...(list ? ["--silent"] : []), workload, "--", "--base", "HEAD", "--working-tree"];
  return list ? [...args, "--list"] : args;
}

interface RunSpec {
  workload: Workload;
  phase: Phase;
  caseId: string | null;
  rep: number;
}

function runLogged(root: string, args: string[], env: NodeJS.ProcessEnv, log: string): Promise<{ code: number | null; signal: string | null }> {
  const fd = openSync(log, "w");
  return new Promise((done) => {
    const child = spawn("npm", args, { cwd: root, env, stdio: ["ignore", fd, fd] });
    child.on("error", (error) => { appendFileSync(log, `\nlaunch error: ${String(error)}\n`); done({ code: null, signal: null }); });
    child.on("close", (code, signal) => done({ code, signal }));
  }).finally(() => closeSync(fd)) as Promise<{ code: number | null; signal: string | null }>;
}

export async function timed(options: Options, spec: RunSpec): Promise<Measurement> {
  const uncached = spec.phase === "uncached" || spec.phase === "changed-uncached";
  const env = uncached ? { ...process.env, NX_SKIP_NX_CACHE: "true" } : { ...process.env };
  const name = [spec.phase, spec.caseId ?? "full", spec.workload.replace(":", "-"), spec.rep].join("-");
  const log = join(options.out, "logs", `${name}.log`);
  const args = npmArgs(spec.workload);
  const load = loadavg();
  const wallStart = Date.now();
  const start = performance.now();
  const { code, signal } = await runLogged(options.root, args, env, log);
  const monotonicSeconds = (performance.now() - start) / 1000;
  const wallSeconds = (Date.now() - wallStart) / 1000;
  const text = readFileSync(log, "utf8");
  const measurement: Measurement = {
    ...spec, command: `${uncached ? "NX_SKIP_NX_CACHE=true " : ""}npm ${args.join(" ")}`,
    exitCode: code, signal, monotonicSeconds, wallSeconds, load,
    nxCache: parseNxCache(text), tests: parseTestCounts(text), log,
  };
  appendFileSync(join(options.out, "measurements.jsonl"), `${JSON.stringify(measurement)}\n`);
  const clock = Math.abs(wallSeconds - monotonicSeconds) > 1 ? " (wall and monotonic clocks disagree)" : "";
  console.error(`${name}: exit ${code ?? signal ?? "unknown"}, ${monotonicSeconds.toFixed(2)} s${clock}`);
  return measurement;
}

function capture(root: string, command: string, args: string[], env = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

/** Removes package outputs and their build info, then resets this checkout's Nx cache. */
export function clearCold(root: string, out: string): void {
  const tsc = capture(root, join(root, "node_modules", ".bin", "tsc"), ["-b", "tsconfig.packages.json", "--clean"]);
  const nx = nxEntry(root);
  const reset = nx ? capture(root, process.execPath, [nx, "reset"], nxEnvironment(root)) : { status: null, stdout: "", stderr: "Nx is not installed" };
  appendFileSync(join(out, "cold-resets.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), tscClean: tsc.status, nxReset: reset.status, stderr: tsc.stderr + reset.stderr })}\n`);
  if (tsc.status !== 0 || reset.status !== 0) throw new Error(`Cold reset failed (tsc --clean ${tsc.status}, nx reset ${reset.status}); see cold-resets.jsonl`);
}

export function environment(root: string): Record<string, unknown> {
  const version = (command: string, args: string[]) => capture(root, command, args).stdout.trim();
  const nx = nxEntry(root);
  return {
    at: new Date().toISOString(),
    commit: version("git", ["rev-parse", "HEAD"]),
    os: `${process.platform} ${release()} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    load: loadavg(),
    node: process.version,
    npm: version("npm", ["--version"]),
    nx: nx ? version(process.execPath, [nx, "--version"]) : null,
    toolchain: version(process.execPath, ["scripts/nx-toolchain.mjs"]),
  };
}

/** The root suites found on disk now, never a remembered count, and their owners. */
export function suiteInventory(root: string): { suites: number; groups: Record<string, number>; problems: string[] } {
  const suites = rootSuites(root);
  const catalog = suiteCatalog(suites);
  const groups = Object.fromEntries(TEST_GROUPS.map((group) => [group.id, group.suites.filter((suite) => suites.includes(suite)).length]));
  return { suites: suites.length, groups, problems: catalog.problems };
}

/** `--list` selections for both affected commands, with only this case's probe applied. */
export function selection(root: string, entry: BenchCase): Record<string, unknown> {
  const restore = applyProbe(root, entry.file, `plan-${entry.id}`);
  try {
    const list = (workload: Workload) => {
      const result = capture(root, "npm", npmArgs(workload, true));
      if (result.status !== 0) throw new Error(`${workload} --list exited ${result.status}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const typecheck = list("affected:typecheck");
    const test = list("affected:test");
    return {
      case: entry.id, boundary: entry.boundary, file: entry.file,
      typecheckProjects: typecheck.projects, typecheckFull: typecheck.full,
      testGroups: test.groups, testSuites: test.suites.length, testFallback: test.fallback,
    };
  } finally {
    restore();
  }
}

let pendingRestore: (() => void) | null = null;

async function fullPhases(options: Options): Promise<void> {
  for (let rep = 1; rep <= options.reps; rep++) {
    for (const workload of ["typecheck", "test"] as const) {
      if (workload === "test" && rep > options.secondaryReps) continue;
      clearCold(options.root, options.out);
      for (const phase of ["cold", "warm", "uncached"] as const) await timed(options, { workload, phase, caseId: null, rep });
    }
  }
}

async function changedPhase(options: Options, phase: "changed" | "changed-uncached"): Promise<void> {
  const reps = phase === "changed" ? options.reps : options.secondaryReps;
  for (let rep = 1; rep <= reps; rep++) {
    for (const entry of options.cases) {
      if (phase === "changed-uncached" && !entry.focus) continue;
      if (!entry.focus && rep > options.secondaryReps) continue;
      pendingRestore = applyProbe(options.root, entry.file, `${phase}-${entry.id}-${rep}-${Date.now()}`);
      try {
        for (const workload of ["affected:typecheck", "affected:test"] as const) await timed(options, { workload, phase, caseId: entry.id, rep });
      } finally {
        pendingRestore();
        pendingRestore = null;
      }
    }
  }
}

interface SummaryRow {
  workload: string;
  phase: string;
  caseId: string | null;
  runs: number;
  median: number;
  min: number;
  max: number;
  exits: (number | string)[];
  nxCache: string[];
  tests: (number | null)[];
}

/** Medians per workload, plus typecheck-plus-test per affected case and the full loop per phase. */
export function summarize(measurements: readonly Measurement[]): SummaryRow[] {
  const rows = new Map<string, Measurement[]>();
  const add = (key: string, entry: Measurement) => rows.set(key, [...(rows.get(key) ?? []), entry]);
  for (const entry of measurements) add(JSON.stringify([entry.workload, entry.phase, entry.caseId]), entry);
  const pairs = new Map<string, Measurement[]>();
  for (const entry of measurements) {
    const key = JSON.stringify([entry.workload.startsWith("affected") ? "affected:typecheck+test" : "typecheck+test", entry.phase, entry.caseId, entry.rep]);
    pairs.set(key, [...(pairs.get(key) ?? []), entry]);
  }
  for (const [key, pair] of pairs) {
    if (pair.length !== 2) continue;
    const [workload, phase, caseId, rep] = JSON.parse(key);
    const failed = pair.find((entry) => entry.exitCode !== 0);
    add(JSON.stringify([workload, phase, caseId]), {
      ...pair[0]!, workload, phase, caseId, rep, command: "both", log: "",
      exitCode: failed ? failed.exitCode : 0, signal: failed?.signal ?? null,
      monotonicSeconds: pair[0]!.monotonicSeconds + pair[1]!.monotonicSeconds, nxCache: null, tests: {},
    });
  }
  return [...rows].map(([key, entries]) => {
    const [workload, phase, caseId] = JSON.parse(key);
    const times = entries.map((entry) => entry.monotonicSeconds);
    return {
      workload, phase, caseId, runs: entries.length, median: median(times), min: Math.min(...times), max: Math.max(...times),
      exits: entries.map((entry) => entry.exitCode ?? entry.signal ?? "unknown"),
      nxCache: entries.map((entry) => (entry.nxCache ? `${entry.nxCache.hits}/${entry.nxCache.total}` : "-")),
      tests: entries.map((entry) => entry.tests.tests ?? null),
    };
  });
}

export function benchmarkArguments(argv: readonly string[], root: string): Options {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const out = value("--out");
  if (!out) throw new Error("Usage: node --import tsx scripts/benchmark-tasks.ts --out <ignored dir> [--phases plan,full,changed,changed-uncached] [--reps 5] [--secondary-reps 3] [--cases cli,http,...]");
  const ids = value("--cases")?.split(",");
  const cases = ids ? CASES.filter((entry) => ids.includes(entry.id)) : CASES;
  if (ids && cases.length !== ids.length) throw new Error(`Unknown case in ${ids.join(",")}; known: ${CASES.map((entry) => entry.id).join(",")}`);
  return {
    root, out: resolve(root, out), cases,
    phases: new Set((value("--phases") ?? "plan,full,changed,changed-uncached").split(",")),
    reps: Number(value("--reps") ?? 5),
    secondaryReps: Number(value("--secondary-reps") ?? 3),
  };
}

async function main(): Promise<number> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const options = benchmarkArguments(process.argv.slice(2), root);
  const dirty = capture(root, "git", ["status", "--porcelain"]).stdout.trim();
  if (dirty) throw new Error(`The checkout must be clean, since affected runs compare HEAD with the working tree:\n${dirty}`);
  mkdirSync(join(options.out, "logs"), { recursive: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { pendingRestore?.(); process.exit(signal === "SIGINT" ? 130 : 143); });
  writeFileSync(join(options.out, "environment.json"), JSON.stringify(environment(root), null, 2));
  if (options.phases.has("plan")) {
    const plan = { inventory: suiteInventory(root), selections: options.cases.map((entry) => selection(root, entry)) };
    writeFileSync(join(options.out, "plan.json"), JSON.stringify(plan, null, 2));
  }
  if (options.phases.has("full")) await fullPhases(options);
  if (options.phases.has("changed")) await changedPhase(options, "changed");
  if (options.phases.has("changed-uncached")) await changedPhase(options, "changed-uncached");
  const lines = readFileSync(join(options.out, "measurements.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
  const summary = summarize(lines.map((line) => JSON.parse(line) as Measurement));
  writeFileSync(join(options.out, "summary.json"), JSON.stringify(summary, null, 2));
  const failed = summary.filter((row) => row.exits.some((exit) => exit !== 0));
  for (const row of failed) console.error(`Non-zero exit: ${row.workload} ${row.phase} ${row.caseId ?? ""} ${row.exits.join(",")}`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => { pendingRestore?.(); console.error(error); process.exitCode = 1; });
}
