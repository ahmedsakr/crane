import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { SimulatedDriver } from "../src/agents/simulated.js";
import { ClaudeCodeDriver } from "../src/agents/claude-code.js";
import type { RunContext, RunResult } from "../src/agents/driver.js";
import type { Task } from "../src/core/types.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-restart-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "restart");
  return { store, actions, repo };
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/** The simulated driver, plus a record of what each run was asked to resume. */
class RecordingDriver extends SimulatedDriver {
  resumed: (string | undefined)[] = [];
  override run(ctx: RunContext): Promise<RunResult> {
    this.resumed.push(ctx.resumeSession);
    return super.run(ctx);
  }
}

test("restart: a running task goes back in the queue and its agent picks up where it left off", async () => {
  const { store, actions, repo } = await setup();
  const t = actions.createTask({ kind: "maintenance", title: "Fix the retries", brief: "", repoId: repo.id, autonomy: "propose" });

  const first = new Factory(store, new SimulatedDriver(40), { crewSize: 1, tickMs: 10 });
  first.start();
  await until(() => !!store.getTask(t.id)?.sessionId, "the agent's session to start");
  const wt = store.getTask(t.id)!.worktree!;
  // Something the agent did before the restart, not yet committed.
  writeFileSync(join(wt, "progress.txt"), "half done\n");
  await first.stop();

  const stopped = store.getTask(t.id)!;
  assert.equal(stopped.status, "queued", "back in the queue, not cancelled");
  assert.equal(stopped.agentId, null);
  assert.equal(stopped.sessionId, `sim-${t.id}`, "the session is kept for the next agent");
  assert.ok(existsSync(wt), "the worktree is kept");
  assert.ok(store.listEvents(t.id).some((e) => /^Stopped with the factory/.test(e.message)));

  const driver = new RecordingDriver(2);
  const second = new Factory(store, driver, { crewSize: 1, tickMs: 10 });
  second.start();
  try {
    await until(() => store.getTask(t.id)?.status === "needs_review", "review");
    const done = store.getTask(t.id)!;
    const events = store.listEvents(t.id).map((e) => e.message);
    assert.deepEqual(driver.resumed, [`sim-${t.id}`], "the agent resumed its own session");
    assert.equal(done.worktree, wt, "same worktree");
    assert.ok(events.includes(`Back on branch ${done.branch}`));
    assert.ok(!events.includes("Cancelled"), events.join("\n"));
    assert.ok(done.report?.changedFiles.includes("progress.txt"), "work from before the restart is kept");
  } finally {
    await second.stop();
    store.close();
  }
});

test("restart: tasks left running by a factory that died are resumed by the next one", async () => {
  const { store, actions, repo } = await setup();
  const t = actions.createTask({ kind: "maintenance", title: "Look around", brief: "", repoId: repo.id, autonomy: "observe" });
  // What a killed factory leaves behind: running, claimed by an agent, with a session.
  store.claimNextTask("a-gone");
  store.updateTask(t.id, { sessionId: "earlier-session" });

  const driver = new RecordingDriver(2);
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10 });
  factory.start();
  try {
    await until(() => !["queued", "running"].includes(store.getTask(t.id)!.status), "it to finish");
    const events = store.listEvents(t.id).map((e) => e.message);
    assert.ok(events.some((m) => /stopped unexpectedly/.test(m)), events.join("\n"));
    assert.deepEqual(driver.resumed, ["earlier-session"]);
    assert.equal(store.getTask(t.id)!.status, "needs_review");
  } finally {
    await factory.stop();
    store.close();
  }
});

test("restart: a task the operator cancelled stays cancelled when the factory stops", async () => {
  const { store, actions, repo } = await setup();
  const t = actions.createTask({ kind: "maintenance", title: "Never mind", brief: "", repoId: repo.id, autonomy: "observe" });
  const factory = new Factory(store, new SimulatedDriver(200), { crewSize: 1, tickMs: 10 });
  factory.start();
  await until(() => !!store.getTask(t.id)?.sessionId, "the agent's session to start");
  actions.cancel(t.id);
  await factory.stop();
  assert.equal(store.getTask(t.id)!.status, "cancelled");
  store.close();
});

test("store: an older database gains the session and agent columns", () => {
  const file = join(mkdtempSync(join(tmpdir(), "crane-")), "old.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, repo_id TEXT,
    autonomy TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, branch TEXT, worktree TEXT, report TEXT,
    cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`);
  old.prepare("INSERT INTO tasks(id, kind, title, brief, autonomy, status, created_at) VALUES('t-old', 'maintenance', 'Old', '', 'observe', 'running', '')").run();
  old.close();

  const store = new Store(file);
  assert.equal(store.getTask("t-old")?.sessionId, null);
  store.updateTask("t-old", { sessionId: "s-1" });
  assert.equal(store.getTask("t-old")?.sessionId, "s-1");
  assert.equal(store.getTask("t-old")?.driver, null, "old tasks run on the default agent");
  store.close();
  new Store(file).close(); // opening it again is a no-op
});

/** A stand-in `claude` that fails to resume, the way it does when a session's history is gone. */
function fakeClaude(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "crane-fake-claude-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) {
  process.stderr.write("No conversation found with session ID: " + args[args.indexOf("--resume") + 1] + "\\n");
  process.exit(1);
}
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
say({ type: "system", subtype: "init", session_id: "fresh-session", model: "fake" });
say({ type: "result", subtype: "success", total_cost_usd: 0.25, result: "Done.\\n\\n\`\`\`crane-report\\n{\\"summary\\":\\"All good\\",\\"findings\\":[],\\"changedFiles\\":[]}\\n\`\`\`" });
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("claude code: resumes with --resume, and starts fresh if the old session can't be loaded", async () => {
  const { bin, log } = fakeClaude();
  const driver = new ClaudeCodeDriver(bin);
  const task = { id: "t-x", kind: "maintenance", title: "X", brief: "", autonomy: "observe", report: null } as unknown as Task;
  const notes: string[] = [];
  const sessions: string[] = [];
  const costs: number[] = [];
  const r = await driver.run({
    task,
    repo: null,
    cwd: tmpdir(),
    signal: new AbortController().signal,
    emit: (_t, m) => void notes.push(m),
    resumeSession: "lost-session",
    onSession: (id) => void sessions.push(id),
    onUsage: (u) => void costs.push(u.costUsd),
  });

  const calls = (await import("node:fs")).readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.slice(calls[0]!.indexOf("--resume"), calls[0]!.indexOf("--resume") + 2), ["--resume", "lost-session"]);
  assert.ok(!calls[1]!.includes("--resume"), "the second try is a fresh session");
  assert.ok(notes.some((n) => /Couldn't pick up the agent's earlier session/.test(n)), notes.join("\n"));
  assert.deepEqual(sessions, ["fresh-session"], "the new session is recorded so a later restart resumes it");
  assert.equal(r.report.summary, "All good");
  assert.deepEqual(costs, [0.25], "only the fresh session reported a cost");
});
