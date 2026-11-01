import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStatus } from "@crane/contracts";
import { AgentRunError, type AgentDriver, type RunContext, type SiblingTask } from "@crane/agent-protocol";
import { Store } from "../src/core/store.js";
import { Factory } from "../src/factory/orchestrator.js";
import { siblingTasksFor } from "../src/factory/task-context.js";
import { resumePrompt, userPrompt } from "../src/agents/prompts.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-context-home-"));

const sh = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", ...args,
], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-context-"));
  sh(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  sh(root, "add", "README.md");
  sh(root, "commit", "-q", "-m", "initial");
  sh(root, "branch", "crane/empty");
  const commit = sh(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "shared setup");
  sh(root, "update-ref", "refs/heads/crane/setup", commit);
  const store = new Store(join(root, "crane.db"));
  const repo = store.addRepo({ path: root, defaultBranch: "main" });
  const base = { kind: "maintenance" as const, brief: "", repoId: repo.id, autonomy: "observe" as const };
  const current = store.createTask({ ...base, title: "Use the shared setup" });
  return { root, store, repo, base, current };
}

test("task context: includes only same-repo pending or unmerged siblings, reading shared refs", async (t) => {
  const { root, store, repo, base, current } = setup();
  t.after(() => store.close());
  const cases: { status: TaskStatus; branch: string | null; hasCommits: boolean | null }[] = [
    { status: "queued", branch: null, hasCommits: false },
    { status: "running", branch: "crane/empty", hasCommits: false },
    { status: "needs_review", branch: "crane/setup", hasCommits: true },
    { status: "approved", branch: "crane/setup", hasCommits: true },
    { status: "merging", branch: "crane/setup", hasCommits: true },
    { status: "done", branch: "crane/setup", hasCommits: true },
    { status: "running", branch: "crane/missing", hasCommits: null },
  ];
  const expected = cases.map(({ status, branch, hasCommits }) => {
    const task = store.createTask({ ...base, title: `${status} setup` });
    // There are no sibling worktrees to inspect: all evidence must come from refs.
    store.updateTask(task.id, { status, branch, worktree: "/unavailable/sibling-worktree" });
    return { id: task.id, title: task.title, status, branch, hasCommits };
  });
  for (const status of ["merged", "rejected", "failed", "cancelled", "done"] as const) {
    const task = store.createTask({ ...base, title: `Exclude ${status}` });
    store.updateTask(task.id, { status, branch: status === "done" ? null : "crane/setup" });
  }
  const other = store.addRepo({ path: join(root, "other") });
  store.createTask({ ...base, repoId: other.id, title: "Other repo" });
  // Finished observations must not crowd older prerequisites out of the bounded snapshot.
  for (let i = 0; i < 205; i++) {
    const task = store.createTask({ ...base, title: `Finished observation ${i}` });
    store.updateTask(task.id, { status: "done" });
  }

  const snapshot = await siblingTasksFor(store, current, repo);
  const byId = (a: SiblingTask, b: SiblingTask) => a.id.localeCompare(b.id);
  assert.deepEqual(snapshot.sort(byId), expected.sort(byId));
  assert.doesNotMatch(JSON.stringify(snapshot), /worktree/);

  sh(root, "update-ref", "refs/heads/main", "refs/heads/crane/setup");
  const afterMerge = await siblingTasksFor(store, current, repo);
  assert.ok(afterMerge.filter((s) => s.branch === "crane/setup").every((s) => s.hasCommits === false));

  const unknown = await siblingTasksFor(store, current, { ...repo, defaultBranch: "missing" });
  assert.ok(unknown.filter((s) => s.branch).every((s) => s.hasCommits === null));
  assert.equal(unknown.find((s) => !s.branch)?.hasCommits, false);
});

test("task context: fresh and resumed prompts expose prerequisite state and preserve the brief", (t) => {
  const { store, current } = setup();
  t.after(() => store.close());
  const siblings: SiblingTask[] = [
    { id: "t-setup", title: "Shared build\nsetup", status: "running", branch: "crane/setup", hasCommits: false },
    { id: "t-review", title: "Contracts", status: "needs_review", branch: "crane/contracts", hasCommits: true },
    { id: "t-unknown", title: "Unknown", status: "queued", branch: null, hasCommits: null },
  ];
  for (const prompt of [userPrompt(current, undefined, siblings), resumePrompt(siblings)]) {
    const rows = prompt.split("\n").filter((line) => line.startsWith('{"id":')).map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.commitsNotOnDefaultBranch), ["no", "yes", "unknown"]);
    assert.equal(rows[0].title, siblings[0]!.title, "multiline titles stay inside their data row");
    assert.equal(rows[0].branch, "crane/setup");
    assert.equal(rows[0].status, "running");
    assert.match(prompt, /snapshot at the start of this run, not a live view/);
    assert.match(prompt, /Do not enter or inspect other tasks' worktrees/);
    assert.match(prompt, /report the unmet prerequisite and unfinished scope explicitly/);
    assert.match(prompt, /do not silently reduce the requested scope/);
  }
  assert.ok(userPrompt(current, undefined, siblings).startsWith(`# ${current.title}\n\n${current.brief}`));
  assert.equal(userPrompt(current), `# ${current.title}\n\n${current.brief}`);
  assert.doesNotMatch(resumePrompt(), /Other recent tasks in this repository/);
  assert.match(resumePrompt([]), /No other pending or unmerged tasks were found/, "clear a resumed session's old snapshot");
});

test("task context: factory supplies snapshots for fresh and resumed work runs", async (t) => {
  const { store, repo, base, current } = setup();
  const sibling = store.createTask({ ...base, title: "Shared build setup" });
  store.updateTask(sibling.id, { status: "needs_review", branch: "crane/empty" });
  const resumed = store.createTask({ ...base, title: "Resumed work" });
  store.updateTask(resumed.id, { sessionId: "earlier-session" });
  const seen: RunContext[] = [];
  const driver: AgentDriver = {
    name: "test", label: "Test", available: async () => true,
    run: async (ctx) => {
      seen.push(ctx);
      assert.equal(ctx.repo?.id, repo.id);
      assert.deepEqual(ctx.siblingTasks?.find((s) => s.id === sibling.id), {
        id: sibling.id, title: sibling.title, status: "needs_review", branch: "crane/empty", hasCommits: false,
      });
      assert.ok(!ctx.siblingTasks?.some((s) => s.id === ctx.task.id));
      return { report: { summary: "Done", findings: [], changedFiles: [] } };
    },
  };
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10 });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  for (let i = 0; i < 500 && store.getTask(resumed.id)?.status !== "done"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.getTask(current.id)?.status, "done");
  assert.equal(store.getTask(resumed.id)?.status, "done");
  assert.equal(seen.length, 2);
  assert.equal(seen.find((ctx) => ctx.task.id === resumed.id)?.resumeSession, "earlier-session");
});

test("task context: transient retries refresh sibling state before resuming", async (t) => {
  const { root, store, base, current } = setup();
  const sibling = store.createTask({ ...base, title: "Shared setup" });
  store.updateTask(sibling.id, { status: "needs_review", branch: "crane/empty" });
  let calls = 0;
  const driver: AgentDriver = {
    name: "test", label: "Test", available: async () => true,
    run: async (ctx) => {
      calls++;
      const state = ctx.siblingTasks?.find((s) => s.id === sibling.id);
      if (calls === 1) {
        assert.equal(state?.hasCommits, false);
        sh(root, "update-ref", "refs/heads/crane/empty", "refs/heads/crane/setup");
        throw new AgentRunError("API Error: 503", { transient: true, sessionId: "retry-session" });
      }
      assert.equal(ctx.resumeSession, "retry-session");
      assert.equal(state?.hasCommits, true);
      return { report: { summary: "Done", findings: [], changedFiles: [] } };
    },
  };
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10, retryDelayMs: 1 });
  t.after(async () => { await factory.stop(); store.close(); });
  factory.start();
  for (let i = 0; i < 500 && store.getTask(current.id)?.status !== "done"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(store.getTask(current.id)?.status, "done");
  assert.equal(calls, 2);
});
