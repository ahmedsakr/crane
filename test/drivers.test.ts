import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { OperatorActions } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import { resolveDefaultDriver } from "../src/factory/drivers.js";
import { SimulatedDriver } from "../src/agents/simulated.js";
import { CodexDriver, codexArgs, unwrapShell, usageFromTurn } from "../src/agents/codex.js";
import type { AgentDriver, RunContext, RunResult } from "../src/agents/driver.js";
import type { RunUsage, Task } from "../src/core/types.js";
import { resumePrompt, systemPrompt } from "../src/agents/prompts.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const REPORT = '```crane-report\\n{\\"summary\\":\\"Codex did it\\",\\"findings\\":[{\\"title\\":\\"One thing\\",\\"detail\\":\\"d\\",\\"impact\\":\\"high\\",\\"effort\\":\\"small\\"}],\\"changedFiles\\":[]}\\n```';

/**
 * A stand-in `codex` that logs its arguments and stdin, then plays back the
 * JSON events `codex exec --json` sends. `mode` picks the story.
 */
function fakeCodex(mode: "ok" | "lost-session" | "turn-failed"): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "crane-fake-codex-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.99.0"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n");
  const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  if (${JSON.stringify(mode)} === "lost-session" && args.includes("resume")) {
    say({ type: "error", message: "No saved session found" });
    process.exit(1);
  }
  say({ type: "thread.started", thread_id: "thread-1" });
  say({ type: "turn.started" });
  if (${JSON.stringify(mode)} === "turn-failed") {
    say({ type: "turn.failed", error: { message: "You've hit your usage limit." } });
    process.exit(1);
  }
  say({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'npm test'", status: "in_progress" } });
  say({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'npm test'", exit_code: 0, status: "completed" } });
  const cwd = args[args.indexOf("--cd") + 1];
  say({ type: "item.completed", item: { id: "i2", type: "file_change", changes: [{ path: cwd + "/src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }] } });
  say({ type: "item.completed", item: { id: "i3", type: "reasoning", text: "thinking" } });
  say({ type: "item.completed", item: { id: "i4", type: "agent_message", text: "Fixed it.\\n\\n${REPORT}" } });
  say({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const calls = (log: string) =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string });

function ctxFor(task: Partial<Task>, extra: Partial<RunContext> = {}) {
  const notes: string[] = [];
  const tools: string[] = [];
  const sessions: string[] = [];
  const usage: RunUsage[] = [];
  const ctx: RunContext = {
    task: { id: "t-x", kind: "maintenance", title: "X", brief: "Do the thing", autonomy: "observe", report: null, ...task } as Task,
    repo: null,
    cwd: tmpdir(),
    signal: new AbortController().signal,
    emit: (type, m) => void (type === "tool" ? tools : notes).push(m),
    onSession: (id) => void sessions.push(id),
    onUsage: (u) => void usage.push(u),
    ...extra,
  };
  return { ctx, notes, tools, sessions, usage };
}

test("prompts: file-edit guidance reaches fresh, conflict and resumed sessions", () => {
  const { ctx } = ctxFor({ autonomy: "propose" });
  const prompts = [
    systemPrompt(ctx.task, null),
    systemPrompt(ctx.task, null, { kind: "resolve_conflicts", base: "origin/main", files: ["a.ts"] }),
    resumePrompt(),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /use your native file-editing tools/);
    assert.match(prompt, /Avoid shell heredocs/);
    assert.match(prompt, /a denied command is still subject to the blocked-command instructions/);
  }
  assert.match(systemPrompt(ctxFor({ autonomy: "observe" }).ctx.task, null), /Do not modify, create, or delete files/);
});

test("codex: runs exec in a read-only sandbox to investigate, and turns its events into the task's", async () => {
  const { bin, log } = fakeCodex("ok");
  const { ctx, notes, tools, sessions, usage } = ctxFor({ autonomy: "observe" });
  const r = await new CodexDriver(bin).run(ctx);

  const [call] = calls(log);
  const at = (flag: string) => call!.args[call!.args.indexOf(flag) + 1];
  assert.equal(call!.args[0], "exec");
  assert.ok(call!.args.includes("--json"));
  assert.equal(at("--sandbox"), "read-only");
  assert.equal(at("--cd"), tmpdir());
  assert.equal(call!.args.at(-1), "-", "the prompt comes on stdin");
  assert.ok(call!.stdin.includes("investigate-only mode"), "Crane's brief leads the prompt");
  assert.ok(call!.stdin.includes("# X\n\nDo the thing"), "then the task itself");

  assert.deepEqual(sessions, ["thread-1"]);
  assert.deepEqual(tools, ["Ran npm test", "Edited src/a.ts", "Wrote src/b.ts"]);
  assert.ok(notes.includes("Fixed it."), notes.join("\n"));
  assert.ok(!notes.some((n) => n.includes("crane-report")), "the report block isn't narrated");
  assert.equal(r.report.summary, "Codex did it");
  assert.equal(r.report.findings[0]?.impact, "high");
  assert.deepEqual(usage, [
    { costUsd: 0, inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, turns: 1, model: null },
  ]);
});

test("codex: work that changes code gets a workspace sandbox with no network, and is told Crane commits", async () => {
  const { bin, log } = fakeCodex("ok");
  await new CodexDriver(bin, "gpt-test").run(ctxFor({ autonomy: "propose" }).ctx);
  const [call] = calls(log);
  const at = (flag: string) => call!.args[call!.args.indexOf(flag) + 1];
  assert.equal(at("--sandbox"), "workspace-write");
  assert.equal(at("--model"), "gpt-test");
  assert.ok(call!.args.includes("sandbox_workspace_write.network_access=false"), "it can't push");
  assert.ok(call!.args.includes("sandbox_workspace_write.writable_roots=[]"), "nothing outside its worktree");
  assert.ok(call!.stdin.includes("Crane commits them"), call!.stdin);
  assert.ok(!call!.stdin.includes("Commit your work"));
});

test("codex: resolving conflicts can edit files even on an investigate-only task", () => {
  const args = codexArgs({ cwd: "/w", readOnly: false, resume: "s-1" });
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.deepEqual(args.slice(-3), ["resume", "s-1", "-"]);
});

test("codex: resumes its session, and starts fresh if the old one can't be loaded", async () => {
  const { bin, log } = fakeCodex("lost-session");
  const { ctx, notes, sessions } = ctxFor({ autonomy: "propose" }, { resumeSession: "old-thread" });
  const r = await new CodexDriver(bin).run(ctx);
  const [first, second] = calls(log);
  assert.deepEqual(first!.args.slice(-3), ["resume", "old-thread", "-"]);
  assert.ok(first!.stdin.includes("Crane restarted"), "a resume is told what happened");
  assert.ok(!second!.args.includes("resume"), "the second try is a fresh session");
  assert.ok(notes.some((n) => /Couldn't pick up the agent's earlier session/.test(n)));
  assert.deepEqual(sessions, ["thread-1"]);
  assert.equal(r.report.summary, "Codex did it");
});

test("codex: a failed turn fails the run with Codex's reason", async () => {
  const { bin } = fakeCodex("turn-failed");
  await assert.rejects(new CodexDriver(bin).run(ctxFor({}).ctx), /usage limit/);
});

test("codex: a missing binary is unavailable", async () => {
  assert.equal(await new CodexDriver("/nonexistent/codex").available(), false);
  assert.equal(await new CodexDriver(fakeCodex("ok").bin).available(), true);
});

test("codex: helpers unwrap shells and count cached tokens apart", () => {
  assert.equal(unwrapShell("bash -lc 'git status'"), "git status");
  assert.equal(unwrapShell('/bin/zsh -lc "ls -la"'), "ls -la");
  assert.equal(unwrapShell(["rg", "-n", "foo"]), "rg -n foo");
  assert.deepEqual(usageFromTurn({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }, "m"), {
    costUsd: 0,
    inputTokens: 6,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    turns: 1,
    model: "m",
  });
});

/** A simulated driver under another name, recording what it ran. */
function named(name: string, available = true) {
  const sim = new SimulatedDriver(5);
  const ran: { task: string; resume?: string }[] = [];
  const d: AgentDriver & { ran: typeof ran } = {
    name,
    label: name,
    ran,
    available: async () => available,
    run: (ctx: RunContext): Promise<RunResult> => {
      ran.push({ task: ctx.task.id, resume: ctx.resumeSession });
      return sim.run(ctx);
    },
  };
  return d;
}

test("registry: auto keeps a saved real agent, skips a saved simulated one, and falls back in order", async () => {
  const claude = named("claude-code");
  const codex = named("codex");
  const sim = named("simulated");
  const missingClaude = named("claude-code", false);
  assert.equal((await resolveDefaultDriver("auto", "codex", [claude, codex, sim])).name, "codex");
  assert.equal((await resolveDefaultDriver("auto", "simulated", [claude, codex, sim])).name, "claude-code");
  assert.equal((await resolveDefaultDriver("auto", null, [missingClaude, codex, sim])).name, "codex");
  assert.equal((await resolveDefaultDriver("auto", null, [missingClaude, sim])).name, "simulated");
  assert.equal((await resolveDefaultDriver("simulated", "codex", [claude, codex, sim])).name, "simulated");
  await assert.rejects(resolveDefaultDriver("gemini", null, [claude]), /Unknown agent/);
});

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-drivers-"));
  const checkout = join(root, "checkout");
  execFileSync("git", [...ID, "init", "-q", "-b", "main", checkout]);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  execFileSync("git", [...ID, "add", "README.md"], { cwd: checkout });
  execFileSync("git", [...ID, "commit", "-q", "-m", "start"], { cwd: checkout });
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "drivers");
  return { store, actions, repo };
}

/** Finished its work: an investigate-only task with findings waits for the operator, otherwise it's done. */
const finished = (store: Store, id: string) => ["done", "needs_review"].includes(store.getTask(id)!.status);

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/** Start a factory that's stopped, and its store closed, when the test ends, pass or fail. */
function startFactory(t: TestContext, store: Store, drivers: AgentDriver | AgentDriver[], crewSize = 1) {
  const factory = new Factory(store, drivers, { crewSize, tickMs: 10 });
  t.after(async () => {
    await factory.stop({ graceMs: 200 });
    store.close();
  });
  factory.start();
  return factory;
}

test("factory: each task runs on the agent it asked for, else the operator's default", async (t) => {
  const { store, actions, repo } = await setup();
  const claude = named("claude-code");
  const codex = named("codex");
  const base = { kind: "maintenance" as const, brief: "", repoId: repo.id, autonomy: "observe" as const };
  const onDefault = actions.createTask({ ...base, title: "Default" });
  const onCodex = actions.createTask({ ...base, title: "Codex", driver: "codex" });

  startFactory(t, store, [claude, codex], 2);
  await until(() => finished(store, onDefault.id) && finished(store, onCodex.id), "both tasks to finish");

  assert.deepEqual(claude.ran.map((r) => r.task), [onDefault.id]);
  assert.deepEqual(codex.ran.map((r) => r.task), [onCodex.id]);
  assert.deepEqual(store.listRuns(onCodex.id).map((r) => r.driver), ["codex"], "the ledger says who ran it");

  // The operator switches the default: the next task without a choice follows it.
  store.setSetting("factory_driver", "codex");
  const later = actions.createTask({ ...base, title: "Later" });
  await until(() => finished(store, later.id), "the later task to finish");
  assert.deepEqual(codex.ran.map((r) => r.task), [onCodex.id, later.id]);
});

test("factory: a task asking for an agent that isn't installed fails with a way forward", async (t) => {
  const { store, actions, repo } = await setup();
  const task = actions.createTask({ kind: "maintenance", title: "X", brief: "", repoId: repo.id, autonomy: "observe", driver: "codex" });
  startFactory(t, store, [named("claude-code"), named("codex", false)]);
  await until(() => store.getTask(task.id)!.status === "failed", "the task to fail");
  const err = store.listEvents(task.id).find((e) => e.type === "error")!;
  assert.match(err.message, /Codex isn't installed/);
  assert.match(err.message, /retry the task on another agent/);
});

test("factory: an interrupted task resumes on the agent that owns its session, even after the default changes", async (t) => {
  const { store, actions, repo } = await setup();
  const claude = named("claude-code");
  const codex = named("codex");
  const task = actions.createTask({ kind: "maintenance", title: "X", brief: "", repoId: repo.id, autonomy: "observe" });
  // An earlier factory started it on Claude Code, then stopped.
  store.finishRun(store.startRun({ taskId: task.id, kind: "work", agentId: null, driver: "claude-code" }), "cancelled", null);
  store.updateTask(task.id, { sessionId: "claude-session" });
  store.setSetting("factory_driver", "codex");

  startFactory(t, store, [codex, claude]);
  await until(() => finished(store, task.id), "the task to finish");
  assert.deepEqual(claude.ran, [{ task: task.id, resume: "claude-session" }]);
  assert.equal(codex.ran.length, 0);
});

test("factory: a session from an agent this factory can't run isn't handed to another", async (t) => {
  const { store, actions, repo } = await setup();
  const codex = named("codex");
  const task = actions.createTask({ kind: "maintenance", title: "X", brief: "", repoId: repo.id, autonomy: "observe" });
  store.finishRun(store.startRun({ taskId: task.id, kind: "work", agentId: null, driver: "claude-code" }), "cancelled", null);
  store.updateTask(task.id, { sessionId: "claude-session" });

  startFactory(t, store, codex);
  await until(() => finished(store, task.id), "the task to finish");
  assert.deepEqual(codex.ran, [{ task: task.id, resume: undefined }]);
  assert.ok(store.listEvents(task.id).some((e) => /Switching to codex/i.test(e.message)));
});

test("actions: agents are checked, kept on retry and follow-up, and can be changed on retry", async () => {
  const { store, actions, repo } = await setup();
  const base = { kind: "maintenance" as const, title: "X", brief: "", repoId: repo.id, autonomy: "observe" as const };
  assert.throws(() => actions.createTask({ ...base, driver: "gemini" }), /Unknown agent/);
  assert.equal(actions.createTask({ ...base, driver: "default" }).driver, null);

  const t = actions.createTask({ ...base, driver: "codex" });
  assert.equal(actions.retry(t.id).driver, "codex", "retry keeps the agent");
  assert.equal(actions.retry(t.id, { driver: "claude-code" }).driver, "claude-code");
  assert.equal(actions.retry(t.id, { driver: null }).driver, null, "or goes back to the default");
  assert.ok(store.listEvents(t.id).some((e) => /on Claude Code$/.test(e.message)));

  store.updateTask(t.id, { report: { summary: "", findings: [{ title: "F", detail: "", impact: "low", effort: "small" }], changedFiles: [] } });
  assert.equal(actions.followUp(t.id, 0).driver, "codex");

  await assert.rejects(actions.setDefaultDriver("gemini"), /Unknown agent/);
  const catalog = await actions.setDefaultDriver("simulated");
  assert.equal(catalog.find((d) => d.isDefault)?.name, "simulated");
  assert.deepEqual(
    catalog.map((d) => d.name),
    ["claude-code", "codex", "simulated"],
  );
  store.close();
});
