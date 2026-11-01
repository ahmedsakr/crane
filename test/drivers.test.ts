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
import type { AgentDriver, ResolveConflictsJob, RunContext, RunResult } from "../src/agent-protocol/index.js";
import type { RunUsage, Task } from "@crane/contracts";
import { resumePrompt, systemPrompt } from "../src/agents/prompts.js";

process.env.CRANE_HOME = mkdtempSync(join(tmpdir(), "crane-home-"));

const REPORT = '```crane-report\\n{\\"summary\\":\\"Codex did it\\",\\"findings\\":[{\\"title\\":\\"One thing\\",\\"detail\\":\\"d\\",\\"impact\\":\\"high\\",\\"effort\\":\\"small\\"}],\\"changedFiles\\":[]}\\n```';

/**
 * A stand-in `codex` that logs its arguments and stdin, then plays back the
 * JSON events `codex exec --json` sends. `mode` picks the story.
 */
function fakeCodex(mode: "ok" | "lost-session" | "turn-failed" | "multi-turn"): { bin: string; log: string } {
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
  if (${JSON.stringify(mode)} === "multi-turn") {
    say({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } });
  }
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

test("prompts: fresh, conflict and resumed sessions preserve refusals and validation gaps", () => {
  const { ctx } = ctxFor({ autonomy: "propose" });
  for (const agentCommits of [true, false]) {
    const prompts = [
      systemPrompt(ctx.task, null, undefined, { agentCommits }),
      systemPrompt(ctx.task, null, { kind: "resolve_conflicts", base: "origin/main", files: ["a.ts"] }, { agentCommits }),
      resumePrompt(),
    ];
    for (const prompt of prompts) {
      assert.match(prompt, /Do not retry the blocked operation through a script, node, Python/);
      assert.match(prompt, /do not guess which part was denied or repackage it/);
      assert.match(prompt, /check remains incomplete in your final report/);
      assert.match(prompt, /Include the blocked command's purpose and any remaining validation/);
    }
  }
  assert.match(resumePrompt(), /Only re-run a command if it was not denied and repeating it is safe/);
});

test("prompts: a sandboxed agent is told which checks its sandbox refuses, and to report them, not work around them", () => {
  const { ctx } = ctxFor({ autonomy: "propose" });
  const conflict = { kind: "resolve_conflicts", base: "origin/main", files: ["a.ts"] } satisfies ResolveConflictsJob;
  for (const prompt of [
    systemPrompt(ctx.task, null, undefined, { agentCommits: false, sandboxed: true }),
    systemPrompt(ctx.task, null, conflict, { agentCommits: false, sandboxed: true }),
    systemPrompt(ctxFor({ autonomy: "observe" }).ctx.task, null, undefined, { sandboxed: true }),
  ]) {
    assert.match(prompt, /listening on a port, even on localhost/);
    assert.match(prompt, /`spawnSync` or `execFileSync` with default stdio/);
    assert.match(prompt, /don't change tests, scripts, or code to get around the sandbox/);
    assert.match(prompt, /list the blocked check in your report as not run, with its error/);
  }
  for (const prompt of [systemPrompt(ctx.task, null), systemPrompt(ctx.task, null, conflict)]) {
    assert.doesNotMatch(prompt, /Your sandbox has no network/, "Claude Code isn't in that sandbox");
  }
});

test("prompts: an agent is told which checks Crane runs after it, so a blocked one isn't raised as a finding", () => {
  const { ctx } = ctxFor({ autonomy: "propose" });
  const conflict = { kind: "resolve_conflicts", base: "origin/main", files: ["a.ts"] } satisfies ResolveConflictsJob;
  const checks = ["npm run typecheck", "npm test"];
  for (const sandboxed of [true, false]) {
    for (const prompt of [
      systemPrompt(ctx.task, null, undefined, { agentCommits: !sandboxed, sandboxed, checks }),
      systemPrompt(ctx.task, null, conflict, { agentCommits: !sandboxed, sandboxed, checks }),
    ]) {
      assert.match(prompt, /After you finish, Crane runs these checks itself/);
      assert.ok(prompt.includes("`npm run typecheck`, `npm test`"), prompt);
      assert.match(prompt, /left to Crane's check, rather than raising a finding about it or calling your validation incomplete/);
      assert.equal(/outside your sandbox/.test(prompt), sandboxed, "only a sandboxed agent hears about its sandbox");
      // It qualifies the general validation rule, so it comes after it.
      assert.ok(prompt.indexOf("After you finish, Crane runs") > prompt.indexOf("Report validation accurately"));
      // The sandbox guidance stays as it is.
      assert.equal(/list the blocked check in your report as not run/.test(prompt), sandboxed);
    }
  }
  for (const prompt of [
    systemPrompt(ctx.task, null),
    systemPrompt(ctx.task, null, undefined, { sandboxed: true, checks: [] }),
    systemPrompt(ctx.task, null, conflict, { sandboxed: true }),
  ]) {
    assert.doesNotMatch(prompt, /Crane runs these checks/, "no checks configured, nothing promised");
  }
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
    { costUsd: 0, costStatus: "unknown", inputTokens: 400, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, turns: 1, model: null },
  ]);
});

test("codex: work that changes code gets a workspace sandbox with no network, and is told Crane commits", async () => {
  const { bin, log } = fakeCodex("ok");
  await new CodexDriver(bin, "gpt-test").run(ctxFor({ autonomy: "propose" }, { checks: ["npm test"] }).ctx);
  const [call] = calls(log);
  const at = (flag: string) => call!.args[call!.args.indexOf(flag) + 1];
  assert.equal(at("--sandbox"), "workspace-write");
  assert.equal(at("--model"), "gpt-test");
  assert.ok(call!.args.includes("sandbox_workspace_write.network_access=false"), "it can't push");
  assert.ok(call!.args.includes("sandbox_workspace_write.writable_roots=[]"), "nothing outside its worktree");
  assert.ok(call!.stdin.includes("Crane commits them"), call!.stdin);
  assert.ok(!call!.stdin.includes("Commit your work"));
  assert.ok(call!.stdin.includes("Your sandbox has no network"), "it knows which checks will be refused");
  assert.ok(call!.stdin.includes("Crane runs these checks itself, outside your sandbox"), "and which ones Crane runs for it");
  assert.ok(call!.stdin.includes("`npm test`"));
});

test("codex: the operator's model and effort win over its env model, and leave the sandbox alone", async () => {
  const { bin, log } = fakeCodex("ok");
  const { ctx, notes } = ctxFor({ autonomy: "propose" }, { model: "gpt-chosen", effort: "high" });
  await new CodexDriver(bin, "gpt-env").run(ctx);
  const [call] = calls(log);
  assert.equal(call!.args[call!.args.indexOf("--model") + 1], "gpt-chosen");
  assert.ok(call!.args.includes('model_reasoning_effort="high"'), call!.args.join(" "));
  assert.equal(call!.args[call!.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(call!.args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(notes.includes("Agent session started on Codex (gpt-chosen, high effort)"), notes.join("\n"));
  // Nothing but a bare word reaches the TOML override.
  assert.ok(!codexArgs({ cwd: "/w", readOnly: true, effort: 'high"\nsandbox_mode="danger-full-access' }).some((a) => a.includes("reasoning")));
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

test("codex: sums estimated cost across completed turns", async () => {
  const { bin } = fakeCodex("multi-turn");
  const { ctx, usage } = ctxFor({}, { model: "gpt-5.3-codex" });
  await new CodexDriver(bin).run(ctx);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.turns, 2);
  assert.ok(Math.abs(usage[0]!.costUsd - 0.00301) < 1e-12);
  assert.equal(usage[0]?.costStatus, "estimated");
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
    costStatus: "unknown",
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
  const tuned: { model?: string; effort?: string }[] = [];
  const checked: { task: string; checks?: string[] }[] = [];
  const d: AgentDriver & { ran: typeof ran; tuned: typeof tuned; checked: typeof checked } = {
    name,
    label: name,
    ran,
    tuned,
    checked,
    available: async () => available,
    run: (ctx: RunContext): Promise<RunResult> => {
      ran.push({ task: ctx.task.id, resume: ctx.resumeSession });
      tuned.push({ model: ctx.model, effort: ctx.effort });
      checked.push({ task: ctx.task.id, checks: ctx.checks });
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
// No stdin pipe: closing one fails with EPERM in Codex's sandbox, so the suite couldn't run there.
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "crane-drivers-"));
  const checkout = join(root, "checkout");
  sh(root, "init", "-q", "-b", "main", checkout);
  writeFileSync(join(checkout, "README.md"), "hi\n");
  sh(checkout, "add", "README.md");
  sh(checkout, "commit", "-q", "-m", "start");
  const store = new Store(join(root, "crane.db"));
  const actions = new OperatorActions(store);
  const repo = await actions.connectRepo(checkout, "drivers");
  store.setRepoChecks(repo.id, ["true"]);
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

test("factory: each run uses the model and effort saved for its agent, read fresh every run", async (t) => {
  const { store, actions, repo } = await setup();
  const claude = named("claude-code");
  const codex = named("codex");
  const base = { kind: "maintenance" as const, brief: "", repoId: repo.id, autonomy: "observe" as const };
  await actions.configureDriver("codex", { model: "gpt-chosen", effort: "xhigh" });
  startFactory(t, store, [claude, codex], 2);

  const first = [actions.createTask({ ...base, title: "Claude" }), actions.createTask({ ...base, title: "Codex", driver: "codex" })];
  await until(() => first.every((x) => finished(store, x.id)), "both tasks to finish");
  assert.deepEqual(codex.tuned, [{ model: "gpt-chosen", effort: "xhigh" }]);
  assert.deepEqual(claude.tuned, [{ model: undefined, effort: undefined }], "one agent's settings don't leak into another's");

  // Changed while the factory runs: the next run picks it up without a restart.
  await actions.configureDriver("claude-code", { model: "opus", effort: "max" });
  const later = actions.createTask({ ...base, title: "Later" });
  await until(() => finished(store, later.id), "the later task to finish");
  assert.deepEqual(claude.tuned.at(-1), { model: "opus", effort: "max" });
});

test("factory: a run that changes code is told the checks Crane runs after it; an investigate-only run isn't", async (t) => {
  const { store, actions, repo } = await setup();
  const agent = named("claude-code");
  const base = { kind: "maintenance" as const, brief: "", repoId: repo.id };
  const propose = actions.createTask({ ...base, title: "Change", autonomy: "propose" });
  const observe = actions.createTask({ ...base, title: "Look", autonomy: "observe" });
  startFactory(t, store, agent);
  await until(() => finished(store, propose.id) && finished(store, observe.id), "both tasks to finish");
  const checksFor = (id: string) => agent.checked.find((c) => c.task === id)?.checks;
  assert.deepEqual(checksFor(propose.id), ["true"], "the repo's configured checks reach the driver");
  assert.equal(checksFor(observe.id), undefined, "Crane runs no checks after an investigate-only run");
  assert.ok(store.getTask(propose.id)!.report!.validation!.some((v) => v.command === "true"), "and Crane did run them");
});

test("driver settings: validated per agent, cleared with default, and shown in the catalog", async () => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  let catalog = await actions.configureDriver("claude-code", { model: " claude-opus-5-5[1m] ", effort: "HIGH" });
  let claude = catalog.find((d) => d.name === "claude-code")!;
  assert.equal(claude.model, "claude-opus-5-5[1m]");
  assert.equal(claude.effort, "high");
  assert.deepEqual(claude.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(claude.models.includes("opus"));
  assert.equal(catalog.find((d) => d.name === "codex")!.model, null, "settings belong to one agent");

  // Leaving a field out keeps it; "default" or null clears it.
  catalog = await actions.configureDriver("claude-code", { effort: "default" });
  claude = catalog.find((d) => d.name === "claude-code")!;
  assert.equal(claude.model, "claude-opus-5-5[1m]");
  assert.equal(claude.effort, null);
  catalog = await actions.configureDriver("claude-code", { model: null });
  assert.equal(catalog.find((d) => d.name === "claude-code")!.model, null);

  await assert.rejects(actions.configureDriver("claude-code", { effort: "minimal" }), /Claude Code takes effort low, medium, high, xhigh, max/);
  await assert.rejects(actions.configureDriver("codex", { effort: "max" }), /Codex takes effort minimal/);
  await assert.rejects(actions.configureDriver("codex", { model: "--dangerously-bypass-approvals-and-sandbox" }), /doesn't look like a model name/);
  await assert.rejects(actions.configureDriver("codex", { model: "gpt 5" }), /doesn't look like a model name/);
  await assert.rejects(actions.configureDriver("simulated", { model: "x" }), /doesn't call a model/);
  await assert.rejects(actions.configureDriver("nope", { model: "x" }), /Unknown agent/);
  assert.equal((await actions.drivers()).find((d) => d.name === "codex")!.effort, null, "a refused change saves nothing");
  store.close();
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

test("crew: preferences persist, on-call members take no work until activated", async (t) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd(), name: "crew-test" });
  const claude = named("claude-code");
  const codex = named("codex");
  const factory = startFactory(t, store, [claude, codex]);
  assert.equal(store.listAgents().length, 8);
  assert.equal(store.listAgents().filter((a) => a.active).length, 1);
  await actions.configureCrew("a-jib", { active: false });
  // Use the store to select a test driver without depending on installed CLIs.
  store.setSetting("crew_driver_a-hoist", "codex");
  const task = actions.createTask({ kind: "maintenance", title: "On call", brief: "", repoId: repo.id, autonomy: "observe" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getTask(task.id)!.status, "queued");
  await actions.configureCrew("a-hoist", { active: true });
  await until(() => finished(store, task.id), "activated member to take work");
  assert.equal(store.getTask(task.id)!.agentId, "a-hoist");
  assert.deepEqual(codex.ran.map((r) => r.task), [task.id]);
  assert.equal(claude.ran.length, 0);
  const explicit = actions.createTask({ kind: "maintenance", title: "Explicit", brief: "", repoId: repo.id, autonomy: "observe", driver: "claude-code" });
  await until(() => finished(store, explicit.id), "explicit choice to override member default");
  assert.deepEqual(claude.ran.map((r) => r.task), [explicit.id]);
  const resumed = actions.createTask({ kind: "maintenance", title: "Resumed", brief: "", repoId: repo.id, autonomy: "observe" });
  store.finishRun(store.startRun({ taskId: resumed.id, kind: "work", agentId: null, driver: "claude-code" }), "cancelled", null);
  store.updateTask(resumed.id, { sessionId: "previous-session" });
  await until(() => finished(store, resumed.id), "session owner to override member default");
  assert.deepEqual(claude.ran.at(-1), { task: resumed.id, resume: "previous-session" });
  await factory.stop();
  const restarted = new Factory(store, [claude, codex], { crewSize: 4 });
  restarted.start();
  try {
    assert.deepEqual(store.listAgents().filter((a) => a.active).map((a) => a.id), ["a-hoist"]);
    assert.equal(store.listAgents().find((a) => a.id === "a-hoist")!.defaultDriver, "codex");
  } finally { await restarted.stop(); }
});

test("crew actions validate preferences and allow following the factory default", async () => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  store.upsertAgent({ id: "a-jib", name: "Jib", driver: "simulated" });
  await assert.rejects(actions.configureCrew("missing", { active: true }), /No crew member/);
  await assert.rejects(actions.configureCrew("a-jib", { defaultDriver: "unknown" }), /Unknown agent/);
  await actions.configureCrew("a-jib", { active: false, defaultDriver: "simulated" });
  assert.equal(store.listAgents()[0]!.active, false);
  assert.equal(store.listAgents()[0]!.defaultDriver, "simulated");
  await actions.configureCrew("a-jib", { defaultDriver: null });
  assert.equal(store.listAgents()[0]!.defaultDriver, null);
  assert.equal(store.listAgents()[0]!.active, false);
  store.close();
});

test("crew: putting a working member on-call lets it finish without taking another task", async (t) => {
  const store = new Store(":memory:");
  const actions = new OperatorActions(store);
  const repo = store.addRepo({ path: process.cwd() });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const driver: AgentDriver = {
    name: "simulated", label: "Simulated", available: async () => true,
    run: async () => { await done; return { report: { summary: "Done", findings: [], changedFiles: [] } }; },
  };
  startFactory(t, store, driver);
  const first = actions.createTask({ kind: "maintenance", title: "First", brief: "", repoId: repo.id, autonomy: "observe" });
  await until(() => store.listRuns(first.id).length > 0, "first task to start");
  await actions.configureCrew("a-jib", { active: false });
  assert.equal(store.getTask(first.id)!.status, "running");
  const second = actions.createTask({ kind: "maintenance", title: "Second", brief: "", repoId: repo.id, autonomy: "observe" });
  finish();
  await until(() => finished(store, first.id), "current task to finish");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.getTask(second.id)!.status, "queued");
  await actions.configureCrew("a-boom", { active: true });
  await until(() => finished(store, second.id), "another member to take the queued task");
  assert.equal(store.getTask(second.id)!.agentId, "a-boom");
});
