import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CASES, applyProbe, benchmarkArguments, median, npmArgs, parseNxCache, parseTestCounts, probeText, summarize,
  suiteInventory, type Measurement,
} from "../scripts/benchmark-tasks.ts";
import { rootSuites } from "../scripts/test-ownership.ts";
import { projectForPath, testProjects } from "../scripts/test-projects.ts";
import { temporaryRoot } from "./support/fixtures.ts";

const root = join(import.meta.dirname, "..");

test("benchmark: cases cover each extraction boundary with an existing file in the expected project", () => {
  assert.deepEqual(CASES.map((entry) => entry.boundary), [
    "CLI-only", "HTTP-only", "factory-only", "storage-only", "runtime-only", "web-only", "shared-contract",
  ]);
  assert.deepEqual(CASES.filter((entry) => entry.focus).map((entry) => entry.id), ["cli", "http"]);
  const projects = testProjects(root);
  const expected: Record<string, string> = { web: "@crane/web", contracts: "@crane/contracts", runtime: "@crane/backend-runtime", storage: "@crane/storage" };
  for (const entry of CASES) {
    assert.ok(existsSync(join(root, entry.file)), entry.file);
    assert.equal(projectForPath(entry.file, projects), expected[entry.id] ?? "backend", entry.id);
  }
});

test("benchmark: a probe is a distinct valid export and restoring returns the exact bytes", (t) => {
  const dir = temporaryRoot(t, "crane-benchmark-");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;");
  const restore = applyProbe(dir, "a.ts", "one");
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), `export const a = 1;${probeText("one")}`);
  assert.notEqual(probeText("one"), probeText("two"));
  restore();
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 1;");
});

test("benchmark: commands are the public task scripts, compared with HEAD on disk", () => {
  assert.deepEqual(npmArgs("test"), ["run", "test"]);
  assert.deepEqual(npmArgs("affected:test"), ["run", "affected:test", "--", "--base", "HEAD", "--working-tree"]);
  assert.deepEqual(npmArgs("affected:typecheck", true), ["run", "--silent", "affected:typecheck", "--", "--base", "HEAD", "--working-tree", "--list"]);
});

test("benchmark: parses Nx cache summaries and node:test counts from either reporter", () => {
  assert.deepEqual(parseNxCache("  Cache:             0/15 hit (0%)\n"), { hits: 0, total: 15 });
  assert.deepEqual(parseNxCache("Nx read the output from the cache instead of running the command for 9 out of 15 tasks."), { hits: 9, total: 15 });
  assert.equal(parseNxCache("Successfully ran target typecheck for 9 projects"), null);
  assert.deepEqual(parseTestCounts("# tests 12\n# pass 11\n# fail 1\n"), { tests: 12, pass: 11, fail: 1 });
  assert.deepEqual(parseTestCounts("ℹ tests 3\nℹ suites 1\n"), { tests: 3, suites: 1 });
});

test("benchmark: summaries take medians and pair typecheck with test per repetition", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const run = (workload: Measurement["workload"], rep: number, seconds: number, exitCode = 0): Measurement => ({
    workload, phase: "changed", caseId: "cli", rep, command: "", exitCode, signal: null, monotonicSeconds: seconds,
    wallSeconds: seconds, load: [], nxCache: null, tests: {}, log: "",
  });
  const rows = summarize([
    run("affected:typecheck", 1, 2), run("affected:test", 1, 10),
    run("affected:typecheck", 2, 3), run("affected:test", 2, 20, 1),
  ]);
  const loop = rows.find((row) => row.workload === "affected:typecheck+test");
  assert.deepEqual({ median: loop?.median, exits: loop?.exits }, { median: 17.5, exits: [0, 1] });
});

test("benchmark: arguments need an output directory and known cases", () => {
  assert.throws(() => benchmarkArguments([], root), /Usage/);
  assert.throws(() => benchmarkArguments(["--out", "x", "--cases", "cli,nope"], root), /Unknown case/);
  const options = benchmarkArguments(["--out", ".crane/bench", "--cases", "http", "--reps", "2"], root);
  assert.deepEqual([options.cases.map((entry) => entry.id), options.reps, options.secondaryReps], [["http"], 2, 3]);
});

test("benchmark: the suite inventory is read from disk", () => {
  const inventory = suiteInventory(root);
  assert.equal(inventory.suites, rootSuites(root).length);
  assert.deepEqual(inventory.problems, []);
});
