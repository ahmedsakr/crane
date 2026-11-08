import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { temporaryRoot } from "./support/fixtures.ts";

/**
 * The public npm scripts, run through npm in a disposable checkout whose Nx is a
 * fake that reports a cache hit and exits with $NX_EXIT. It proves the link check
 * runs outside Nx, the exit status survives npm, and Nx runs without its daemon.
 */

const root = join(import.meta.dirname, "..");
const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const FAKE_NX = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.NX_LOG, JSON.stringify({ args: process.argv.slice(2), daemon: process.env.NX_DAEMON, tui: process.env.NX_TUI }) + "\\n");
console.log("Nx read the output from the cache instead of running the command for 15 out of 15 tasks.");
process.exitCode = Number(process.env.NX_EXIT ?? 0);
`;

function checkout(t: TestContext) {
  const dir = temporaryRoot(t, "crane-tasks-process-");
  const log = join(dir, "nx.log");
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  for (const script of ["tasks.ts", "changes.ts", "test-runner.ts", "check-workspace-links.mjs"]) {
    cpSync(join(root, "scripts", script), join(dir, "scripts", script));
  }
  put("package.json", JSON.stringify({ type: "module", workspaces: ["a"], scripts: { typecheck: scripts.typecheck, test: scripts.test } }));
  put("a/package.json", JSON.stringify({ name: "@fixture/a" }));
  mkdirSync(join(dir, "node_modules", "@fixture"), { recursive: true });
  symlinkSync(join(dir, "a"), join(dir, "node_modules", "@fixture", "a"));
  symlinkSync(join(root, "node_modules", "tsx"), join(dir, "node_modules", "tsx"));
  put("node_modules/nx/package.json", JSON.stringify({ name: "nx", type: "module", bin: { nx: "./dist/bin/nx.js" } }));
  put("node_modules/nx/dist/bin/nx.js", FAKE_NX);
  const env: NodeJS.ProcessEnv = { ...process.env, NX_LOG: log, NX_DAEMON: "true", NX_TUI: "true" };
  delete env.NODE_TEST_CONTEXT;
  return {
    dir,
    npm: (script: string, nxExit = 0) => spawnSync("npm", ["run", "--silent", script], { cwd: dir, encoding: "utf8", env: { ...env, NX_EXIT: String(nxExit) } }),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

test("tasks process: npm run typecheck runs every project's typecheck in Nx without its daemon or TUI", (t) => {
  const { npm, calls } = checkout(t);
  const run = npm("typecheck");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /from the cache/);
  assert.deepEqual(calls(), [{ args: ["run-many", "-t", "typecheck", "--outputStyle=static-failures-only"], daemon: "false", tui: "false" }]);
});

test("tasks process: an Nx failure keeps its nonzero status through npm", (t) => {
  const { npm } = checkout(t);
  assert.equal(npm("typecheck", 3).status, 3);
  assert.equal(npm("typecheck", 1).status, 1);
});

test("tasks process: a broken workspace link fails npm typecheck and test before Nx reports a cache hit", (t) => {
  const { dir, npm, calls } = checkout(t);
  rmSync(join(dir, "node_modules", "@fixture", "a"));
  for (const script of ["typecheck", "test"]) {
    const run = npm(script);
    assert.equal(run.status, 1, script);
    assert.match(run.stderr, /Workspace links are missing or incorrect: @fixture\/a/, script);
    assert.match(run.stderr, /run npm install/, script);
  }
  assert.deepEqual(calls(), [], "Nx never started, so no cached result could stand in for the check");
});

test("tasks process: a missing Nx install fails after the link check, with the install hint", (t) => {
  const { dir, npm } = checkout(t);
  rmSync(join(dir, "node_modules", "nx"), { recursive: true });
  const run = npm("typecheck");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Nx is not installed[\s\S]*run npm install/);
});

test("tasks process: a usage error exits 2 with the usage text", (t) => {
  const { dir } = checkout(t);
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/tasks.ts", "affected", "test", "--base", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /exactly one of --head <rev> or --working-tree[\s\S]*Usage:/);
});
