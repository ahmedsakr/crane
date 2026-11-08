import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { onFixtureCleanup, temporaryRoot } from "./support/fixtures.ts";

// These fixtures need native node:test worker processes. Run outside the no-network
// sandbox with npm test; lifecycle unit fixtures live in test-runner.test.ts.
const root = join(import.meta.dirname, "..");
const runner = pathToFileURL(join(root, "scripts/test-runner.ts")).href;

function launch(t: TestContext, files: Record<string, string>) {
  const dir = temporaryRoot(t, "crane-test-runner-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const log = join(dir, "output.log");
  const fd = openSync(log, "w");
  const source = `import { runTestSuites } from ${JSON.stringify(runner)};
    process.exitCode = await runTestSuites(${JSON.stringify(Object.keys(files).map((name) => join(dir, name)))}, { cwd: ${JSON.stringify(root)} });`;
  // Don't inherit the outer node:test worker context into a fresh runner.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: root, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  onFixtureCleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await done; });
  return { child, done, dir, output: () => readFileSync(log, "utf8") };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test-runner fixture");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("test runner process: actual Node failures retain assertion diagnostics and suite isolation", { timeout: 30_000 }, async (t) => {
  const isolated = `import assert from "node:assert/strict";
    import { test } from "node:test";
    test("isolated fixture", () => { assert.equal(globalThis.sharedFixture, undefined); globalThis.sharedFixture = true; });`;
  const f = launch(t, {
    "one.test.ts": isolated,
    "two.test.ts": isolated,
    "fail.test.ts": 'import { test } from "node:test"; test("failure fixture", () => { throw new Error("expected fixture failure"); });',
  });
  assert.deepEqual(await f.done, { code: 1, signal: null });
  assert.match(f.output(), /expected fixture failure/);
  assert.match(f.output(), /isolated fixture/);
  assert.doesNotMatch(f.output(), /ERR_ASSERTION/);
});

test("test runner process: successful isolated files return an authoritative zero exit", { timeout: 30_000 }, async (t) => {
  const f = launch(t, { "pass.test.ts": 'import { test } from "node:test"; test("pass fixture", () => {});' });
  assert.deepEqual(await f.done, { code: 0, signal: null });
  assert.match(f.output(), /pass fixture/);
});

test("test runner process: SIGTERM cancels the worker group and cannot report success", { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
  const f = launch(t, {
    "wait.test.ts": `import { test } from "node:test";
      import { writeFileSync } from "node:fs";
      import { dirname, join } from "node:path";
      import { fileURLToPath } from "node:url";
      const dir = dirname(fileURLToPath(import.meta.url));
      process.once("SIGTERM", () => { writeFileSync(join(dir, "stopped"), "yes"); process.exit(0); });
      test("waiting fixture", async () => {
        writeFileSync(join(dir, "ready"), "yes");
        await new Promise(() => { setInterval(() => {}, 1000); });
      });`,
  });
  await until(() => existsSync(join(f.dir, "ready")));
  assert.equal(f.child.kill("SIGTERM"), true);
  assert.deepEqual(await f.done, { code: 143, signal: null });
  assert.match(f.output(), /Test execution cancelled \(SIGTERM\)/);
  await until(() => existsSync(join(f.dir, "stopped")));
});
