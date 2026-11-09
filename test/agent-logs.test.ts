import "../src/application.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunError, type AgentDriver, type AgentJob } from "@crane/agent-protocol";
import { Store } from "@crane/storage";
import { git } from "@crane/backend-runtime";
import { worktreesDir } from "@crane/backend-runtime";
import { prepareAgentLogs } from "../packages/factory/src/agent-logs.js";
import { runAgent } from "../packages/factory/src/agent-runner.js";
import { resumePrompt, userPrompt } from "../packages/agent-drivers/src/prompts.js";
import { onFixtureCleanup, temporaryRoot, testHome } from "./support/fixtures.js";

function setup(t: TestContext) {
  testHome(t);
  const store = new Store(":memory:");
  onFixtureCleanup(t, () => store.close());
  const checkout = temporaryRoot(t, "crane-log-checkout-");
  const repo = store.addRepo({ path: checkout });
  const task = store.createTask({ kind: "maintenance", title: "Logs", brief: "", repoId: repo.id, autonomy: "propose" });
  const cwd = join(worktreesDir(), task.id);
  mkdirSync(cwd);
  return { store, task, repo, cwd, checkout };
}

test("runner prepares writable logs for work, retries, resume and merge jobs before driver execution", async (t) => {
  const { store, task, repo, cwd, checkout } = setup(t);
  store.upsertAgent({ id: "log-agent", name: "Logger", driver: "test" });
  const directories: string[] = [];
  const jobs: (AgentJob | undefined)[] = [undefined,
    { kind: "resolve_conflicts", phase: "edit", base: "main", files: [] },
    { kind: "resolve_conflicts", phase: "validate", checkpoint: "saved", base: "main", files: [] },
    { kind: "fix_checks", base: "main", commit: "saved", failures: [] },
  ];
  const driver: AgentDriver = { name: "test", label: "Test", available: async () => true, run: async (ctx) => {
    const directory = ctx.logDirectory!;
    assert.ok(directory.startsWith(join(cwd, ".crane-logs-")));
    assert.equal(readFileSync(join(directory, ".gitignore"), "utf8"), "*\n");
    writeFileSync(join(directory, "check.log"), "diagnostics");
    assert.equal(readFileSync(join(directory, "check.log"), "utf8"), "diagnostics");
    for (const prompt of [userPrompt(ctx.task, ctx.job, ctx), resumePrompt(ctx)]) {
      assert.ok(prompt.includes(JSON.stringify(directory)));
      assert.match(prompt, /existing directory using a shell-quoted path/);
      assert.match(prompt, /exit=0.*not process metadata/);
      assert.match(prompt, /report the outcome as unknown/);
      assert.match(prompt, /if a command is refused, do not retry it/);
    }
    assert.ok(!directories.includes(directory));
    directories.push(directory);
    if (directories.length === 1) throw new AgentRunError("API Error: 503", { transient: true, sessionId: "retry" });
    assert.ok(ctx.resumeSession);
    return { report: { summary: "Done", findings: [], changedFiles: [] } };
  } };
  for (const job of jobs) {
    await runAgent({ store, maxTurns: 0, retryDelayMs: 1 }, "log-agent", driver, {
      task, repo, cwd, signal: new AbortController().signal, emit: () => {}, job, resumeSession: "saved-session",
    });
  }
  assert.equal(directories.length, 5);
  assert.deepEqual(readdirSync(checkout), []);
  assert.equal(readFileSync(join(directories[0]!, "check.log"), "utf8"), "diagnostics");
});

test("observe runs neither prepare nor advertise a writable logging destination", async (t) => {
  const { task, repo, checkout } = setup(t);
  const observe = { ...task, autonomy: "observe" as const };
  assert.equal(await prepareAgentLogs({ task: observe, repo, cwd: checkout }), undefined);
  assert.deepEqual(readdirSync(checkout), []);
  assert.doesNotMatch(userPrompt(observe), /## Command logs/);
  assert.doesNotMatch(resumePrompt({ task: observe }), /## Command logs/);
});

test("logs and their ignore file stay out of Git contributions without repository ignore rules", async (t) => {
  const { task, repo, cwd } = setup(t);
  await git(cwd, "init", "--initial-branch=main");
  const directory = (await prepareAgentLogs({ task, repo, cwd }))!;
  writeFileSync(join(directory, "output.txt"), "check output");
  assert.equal(await git(cwd, "status", "--porcelain", "--untracked-files=all"), "");
  const ignored = await git(cwd, "ls-files", "--others", "--ignored", "--exclude-standard");
  assert.match(ignored, /\.gitignore/);
  assert.match(ignored, /output\.txt/);
});

test("preparation rejects operator checkout, paths outside worktrees and symlink escapes", async (t) => {
  const { task, repo, checkout } = setup(t);
  const outside = temporaryRoot(t, "crane-log-outside-");
  const link = join(worktreesDir(), "escape");
  symlinkSync(outside, link);
  for (const cwd of [checkout, outside, worktreesDir(), link]) {
    await assert.rejects(prepareAgentLogs({ task, repo, cwd }), /only prepare agent logs inside an isolated worktree/);
  }
  assert.deepEqual(readdirSync(checkout), []);
  assert.deepEqual(readdirSync(outside), []);
});
