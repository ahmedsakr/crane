import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { fakeClaude } from "./support/fake-agents.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@crane/storage";
import { ClaudeCodeDriver } from "@crane/agent-drivers";
import { describeBlocked, toolsFor } from "../packages/agent-drivers/src/claude-code.js";
import { ALWAYS_DENIED } from "@crane/agent-policy";
import { AgentRunError, isTransientFailure, type AgentDriver, type RunContext, type RunResult } from "@crane/agent-protocol";
import { OperatorActions, toRule } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import type { BlockedCall, EventType, Repo, Task } from "@crane/contracts";

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
const newStore = () => new Store(join(scratch("crane-"), "t.db"));

// ── the Claude Code driver's permissions ──────────────────
// Rule matching, suggestions and the deny list itself are tested in agent-policy.test.ts.

test("permissions: the Claude Code driver denies Crane's deny list", () => {
  assert.deepEqual(toolsFor("propose").denied, ALWAYS_DENIED);
  assert.deepEqual(toolsFor("observe").denied, ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED]);
});

test("permissions: the driver's observe tools leave refused parts to suggest", () => {
  assert.deepEqual(describeBlocked("Bash", { command: "npm ci && npm run build | tail -3" }, toolsFor("observe")).data.rules, [
    "Bash(npm ci:*)",
    "Bash(npm run build:*)",
  ]);
});

test("permissions: heredoc data never becomes an allow-rule suggestion", () => {
  for (const command of [
    "cat > file.ts <<'EOF'\nnpm publish\nEOF",
    "node <<EOF\nconsole.log('hello')\nEOF",
    "cat <<-END\n\tgit push origin HEAD\n\tEND\nnpm ci",
    "cat <<< 'hello'",
  ]) {
    const blocked = describeBlocked("Bash", { command }, toolsFor("propose"));
    assert.deepEqual(blocked.data.rules, [], command);
    assert.equal(blocked.data.command, command, "keep the command available for operator review");
  }
});

test("permissions: repo rules are added, and the deny list stays", () => {
  const t = toolsFor("propose", ["Bash(docker compose:*)"]);
  assert.ok(t.allowed.includes("Bash(docker compose:*)"));
  for (const d of ALWAYS_DENIED) assert.ok(t.denied.includes(d));
});

test("permissions: compound screenshot refusals keep evidence even with no suggested rules", () => {
  const command = 'npm run build && npm run screenshot -- "$NAV" --click "$OPEN" --out .crane/menu.png';
  const reason = "This command requires approval";
  const blocked = describeBlocked("Bash", { command }, toolsFor("propose"), {
    toolUseId: "screenshot-1",
    refusal: { source: "claude-code.tool_result", reason },
  });
  assert.deepEqual(blocked.data.rules, [], "suggestions cannot explain the driver's refusal");
  assert.equal(blocked.data.command, command);
  assert.equal(blocked.data.toolUseId, "screenshot-1");
  assert.deepEqual(blocked.data.refusal, { source: "claude-code.tool_result", reason });

  const summaryOnly = describeBlocked("Bash", { command }, toolsFor("propose"), {
    refusal: { source: "claude-code.permission_denials", reason: null },
  });
  assert.equal(summaryOnly.data.refusal!.reason, null, "never guess that variables caused the refusal");
  const longReason = describeBlocked("Bash", { command }, toolsFor("propose"), {
    refusal: { source: "claude-code.tool_result", reason: reason.repeat(1000) },
  });
  assert.equal(longReason.data.refusal!.reason!.length, 4000);
});

test("transient: overload, rate limits and network errors, but not plan usage limits", () => {
  assert.ok(isTransientFailure('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'));
  assert.ok(isTransientFailure("API Error: 429 rate_limit_error"));
  assert.ok(isTransientFailure("request failed: ECONNRESET"));
  assert.ok(!isTransientFailure("Claude AI usage limit reached|1761955200"));
  assert.ok(!isTransientFailure("TypeError: cannot read properties of undefined"));
  assert.ok(!isTransientFailure("Claude Code exited with code 1. Error at line 500"));
});

// ── the Claude Code driver, against a stand-in `claude` ───

const repo: Repo = { id: "r-x", name: "x", path: "/code/x", defaultBranch: "main", isFactory: false, addedAt: "" };
const task = (autonomy: Task["autonomy"] = "observe"): Task => ({
  id: "t-1",
  kind: "maintenance",
  title: "Check the build",
  brief: "Check the build",
  repoId: repo.id,
  autonomy,
  status: "running",
  agentId: null,
  branch: null,
  worktree: null,
  sessionId: null,
  driver: null,
  model: null,
  effort: null,
  driverSettings: null,
  assignee: null,
  postmortemOf: null,
  preApprovedAt: null,
  prerequisites: [],
  prerequisitesWaivedAt: null,
  acceptance: [],
  acceptanceChecks: [],
  lookouts: [],
  report: null,
  costUsd: 0,
  createdAt: "",
  createdBy: null,
  scheduledAt: null,
  scheduleId: null,
  followUpOf: null,
  followUpFinding: null,
  startedAt: null,
  finishedAt: null,
});

function collect() {
  const events: { type: EventType; message: string; data?: Record<string, unknown> }[] = [];
  return { events, emit: (type: EventType, message: string, data?: Record<string, unknown>) => void events.push({ type, message, data }) };
}

test("driver: persists Claude multiline commands and ordinary results with tool-use IDs", async () => {
  const command = 'node -e "\nconsole.log(1);\nprocess.exit(2);\n"';
  const fake = fakeClaude([
    { type: "system", subtype: "init", session_id: "evidence-session" },
    { type: "assistant", message: { content: [
      { type: "tool_use", id: "regression", name: "Bash", input: { command } },
      { type: "tool_use", id: "compiler", name: "Bash", input: { command: `API_TOKEN=hide-me npm run typecheck\n${"x".repeat(9000)}` } },
      { type: "tool_use", id: "missing-result", name: "Bash", input: { command: "npm test" } },
      { type: "tool_use", id: "tap-result", name: "Bash", input: { command: "npm test" } },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "regression", is_error: true, content: "Expected failure\nAPI_TOKEN=hide-me" },
    ] }, tool_use_result: { exit_code: 2, stderr: "Expected failure", stdout: "1\n" } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "compiler", is_error: false, content: "Typecheck passed" },
    ] }, tool_use_result: { exitCode: 0 } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tap-result", is_error: false, content: "# tests 12\n# pass 12\n# fail 0" },
    ] }, tool_use_result: { stdout: "# tests 12\n# pass 12\n# fail 0", stderr: "", interrupted: false } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "unmatched", content: "diagnostic without a call" },
    ] } },
    { type: "result", subtype: "success", result: "Done" },
  ]);
  const { events, emit } = collect();
  const result = await new ClaudeCodeDriver(fake.bin).run({ task: task(), repo, cwd: scratch("crane-cwd-"), signal: new AbortController().signal, emit });
  const commands = events.filter((e) => e.data?.command).map((e) => e.data!.command as import("@crane/contracts").CommandEvidence);
  const regression = commands.filter((c) => c.itemId === "regression");
  assert.equal(regression.length, 2);
  assert.equal(regression[0]!.command, command);
  assert.equal(regression[1]!.commandId, regression[0]!.commandId);
  assert.equal(regression[1]!.status, "failed");
  assert.equal(regression[1]!.exitCode, 2);
  assert.equal(commands.find((c) => c.itemId === "compiler" && c.status === "completed")!.truncated, true);
  assert.equal(commands.at(-1)!.status, "unknown", "a missing result never implies success");
  assert.equal(commands.find(c => c.itemId === "tap-result" && c.status === "unknown")!.exitCode, null);
  assert.match(result.report.summary, /2 Bash command\(s\) have no recorded process exit code/);
  assert.match(result.report.summary, /npm test/);
  assert.equal(events.filter((e) => e.data?.result).length, 4, "ordinary and unmatched results are retained");
  assert.ok(!JSON.stringify(events).includes("hide-me"));
  assert.equal(events.filter((e) => e.type === "blocked").length, 0, "regression failures aren't refusals");
});

test("driver: reports each blocked call once, with the rules that would allow it", async () => {
  const command = "npm ci && npm test 2>&1 | tail -5";
  const fake = fakeClaude([
    { type: "system", subtype: "init", session_id: "s-1", model: "m" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command } }] } },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }],
      },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls -la" } }] } },
    // An ordinary failing command is not a refusal.
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", is_error: true, content: "ls: Permission denied" }] } },
    {
      type: "result",
      subtype: "success",
      result: 'Done.\n\n```crane-report\n{"summary":"ok","findings":[],"changedFiles":[]}\n```',
      total_cost_usd: 0.25,
      session_id: "s-1",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "tu1", tool_input: { command } },
        { tool_name: "Bash", tool_use_id: "tu3", tool_input: { command: "git push origin HEAD" } },
      ],
    },
  ]);
  const { events, emit } = collect();
  const costs: number[] = [];
  await new ClaudeCodeDriver(fake.bin).run({
    task: task(),
    repo,
    cwd: scratch("crane-cwd-"),
    signal: new AbortController().signal,
    emit,
    onUsage: (u) => void costs.push(u.costUsd),
    allowedTools: ["Bash(docker compose:*)"],
    maxTurns: 7,
    model: "opus",
    effort: "high",
    checks: ["npm test"],
  });
  assert.deepEqual(costs, [0.25]);
  const blocked = events.filter((e) => e.type === "blocked");
  assert.equal(blocked.length, 2);
  assert.equal(blocked[0]!.message, `Blocked: ${command}`);
  assert.deepEqual((blocked[0]!.data as unknown as BlockedCall).rules, ["Bash(npm ci:*)", "Bash(npm test:*)"]);
  assert.deepEqual((blocked[1]!.data as unknown as BlockedCall).rules, [], "git push is refused on purpose, so nothing is offered");
  assert.equal(blocked[0]!.data!.toolUseId, "tu1");
  assert.deepEqual(blocked[0]!.data!.refusal, {
    source: "claude-code.tool_result",
    reason: "Claude requested permissions to use Bash, but you haven't granted it yet.",
  }, "the final summary must not replace live refusal evidence");
  assert.deepEqual(blocked[1]!.data!.refusal, { source: "claude-code.permission_denials", reason: null });

  const args = fake.args();
  assert.equal(args[args.indexOf("--max-turns") + 1], "7");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(args[args.indexOf("--allowedTools") + 1]!.split(",").includes("Bash(docker compose:*)"));
  assert.ok(args[args.indexOf("--disallowedTools") + 1]!.split(",").includes("Bash(git push:*)"));
  assert.match(args[args.indexOf("--append-system-prompt") + 1]!, /Crane runs these checks itself, in this directory, .*`npm test`/);
});

test("driver: reports refusals in Claude Code's current wording as they happen", async () => {
  const refusal = (id: string, content: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] },
  });
  const fake = fakeClaude([
    { type: "system", subtype: "init", session_id: "s-2", model: "m" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npx tsc" } }] } },
    refusal("tu1", "This command requires approval"),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls && npm ci" } }] } },
    refusal("tu2", "This Bash command contains multiple operations. The following part requires approval: npm ci"),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu3", name: "Bash", input: { command: "gh pr merge" } }] } },
    // A failing command whose own output mentions approval is not a refusal.
    refusal("tu3", "Exit code 1\nPull request requires approval from a reviewer"),
    // No permission_denials, so only live detection can report these.
    {
      type: "result",
      subtype: "success",
      result: 'Done.\n\n```crane-report\n{"summary":"ok","findings":[],"changedFiles":[]}\n```',
      total_cost_usd: 0.1,
      session_id: "s-2",
    },
  ]);
  const { events, emit } = collect();
  await new ClaudeCodeDriver(fake.bin).run({
    task: task(),
    repo,
    cwd: scratch("crane-cwd-"),
    signal: new AbortController().signal,
    emit,
  });
  assert.deepEqual(
    events.filter((e) => e.type === "blocked").map((e) => e.message),
    ["Blocked: npx tsc", "Blocked: ls && npm ci"],
  );
  assert.deepEqual(events.filter((e) => e.type === "blocked")[1]!.data!.refusal, {
    source: "claude-code.tool_result",
    reason: "This Bash command contains multiple operations. The following part requires approval: npm ci",
  });
});

test("driver: an overloaded API is a transient failure that keeps its cost and session", async () => {
  const fake = fakeClaude([
    { type: "system", subtype: "init", session_id: "s-9" },
    { type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded_error", total_cost_usd: 0.4, session_id: "s-9" },
  ]);
  const costs: number[] = [];
  const err = await new ClaudeCodeDriver(fake.bin)
    .run({
      task: task(),
      repo,
      cwd: scratch("crane-cwd-"),
      signal: new AbortController().signal,
      emit: () => {},
      onUsage: (u) => void costs.push(u.costUsd),
      resumeSession: "s-9",
    })
    .catch((e) => e);
  assert.ok(err instanceof AgentRunError);
  assert.ok(err.transient);
  assert.deepEqual(costs, [0.4]);
  assert.equal(err.sessionId, "s-9");
  const args = fake.args();
  assert.equal(args[args.indexOf("--resume") + 1], "s-9");
});

test("driver: running out of turns says so, and isn't retried", async () => {
  const fake = fakeClaude([{ type: "result", subtype: "error_max_turns", num_turns: 7, total_cost_usd: 1 }]);
  const err = await new ClaudeCodeDriver(fake.bin)
    .run({ task: task(), repo, cwd: scratch("crane-cwd-"), signal: new AbortController().signal, emit: () => {}, maxTurns: 7 })
    .catch((e) => e);
  assert.ok(err instanceof AgentRunError);
  assert.equal(err.opts.limit, "turns");
  assert.ok(!err.transient);
  assert.match(err.message, /Stopped after 7 turns/);
});

test("driver: a CLI that exits before reading its prompt fails the run, not the factory", async () => {
  const dir = scratch("crane-fake-claude-");
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\nexit 3\n");
  chmodSync(bin, 0o755);
  // Far past what a pipe buffers, so writing it hits EPIPE once the CLI is gone.
  const brief = "x".repeat(4 * 1024 * 1024);
  const err = await new ClaudeCodeDriver(bin)
    .run({ task: { ...task(), brief }, repo, cwd: scratch("crane-cwd-"), signal: new AbortController().signal, emit: () => {} })
    .catch((e) => e);
  assert.ok(err instanceof AgentRunError);
  assert.match(err.message, /exited with code 3/);
});

// ── the factory: retries and the time limit ─────────────

/** A driver that plays one scripted behaviour per call. */
class ScriptedDriver implements AgentDriver {
  readonly name = "scripted";
  readonly label = "Scripted";
  calls: RunContext[] = [];
  constructor(private script: ((ctx: RunContext) => Promise<RunResult>)[]) {}
  async available() {
    return true;
  }
  run(ctx: RunContext) {
    this.calls.push(ctx);
    return this.script[this.calls.length - 1]!(ctx);
  }
}

const spend = (ctx: RunContext, costUsd: number) =>
  ctx.onUsage?.({ costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, model: null });
const ok = async (ctx: RunContext): Promise<RunResult> => {
  spend(ctx, 0.1);
  return { report: { summary: "ok", findings: [], changedFiles: [] } };
};
const overloaded = async (ctx: RunContext): Promise<RunResult> => {
  spend(ctx, 0.3);
  throw new AgentRunError("API Error: 529 overloaded_error", { transient: true, sessionId: "s-1" });
};
const hang = (ctx: RunContext) =>
  new Promise<RunResult>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("Cancelled by operator"))));

async function runOne(driver: AgentDriver, opts: { timeLimitMin?: number } = {}) {
  const store = newStore();
  const r = store.addRepo({ path: scratch("crane-repo-") });
  store.setRepoTools(r.id, { allowed: ["Bash(npm ci:*)"], keptBlocked: [] });
  const t = store.createTask({ kind: "maintenance", title: "x", brief: "", repoId: r.id, autonomy: "observe" });
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 10, retryDelayMs: 5, ...opts });
  factory.start();
  for (let i = 0; i < 300 && ["queued", "running"].includes(store.getTask(t.id)!.status); i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  await factory.stop();
  return { store, task: store.getTask(t.id)!, events: store.listEvents(t.id) };
}

// ── the factory: staying up when a write fails ──────────

function resilienceSetup(driver: AgentDriver) {
  const store = newStore();
  const r = store.addRepo({ path: scratch("crane-repo-") });
  const newTask = (title: string) => store.createTask({ kind: "maintenance", title, brief: "", repoId: r.id, autonomy: "observe" });
  const logs: string[] = [];
  const factory = new Factory(store, driver, { crewSize: 1, tickMs: 5, retryDelayMs: 5, log: (l) => void logs.push(l) });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((res) => setTimeout(res, 10));
    assert.ok(ok(), `timed out waiting for ${what}`);
  };
  return { store, newTask, logs, factory, until };
}

test("factory: a store error during a tick is logged once, and the next tick carries on", async () => {
  const { store, newTask, logs, factory, until } = resilienceSetup(new ScriptedDriver([ok]));
  const t = newTask("x");
  const setSetting = store.setSetting.bind(store);
  let failures = 5;
  store.setSetting = (key, value) => {
    if (key === "factory_heartbeat" && failures-- > 0) throw new Error("database is locked");
    setSetting(key, value);
  };
  factory.start();
  await until(() => store.getTask(t.id)!.status === "done", "the task to finish after the store recovers");
  await factory.stop();
  assert.equal(logs.filter((l) => l.includes("database is locked")).length, 1, logs.join("\n"));
});

test("factory: a task whose failure can't be recorded doesn't take the factory with it", async () => {
  const failing = async (): Promise<RunResult> => {
    throw new Error("the agent broke");
  };
  const { store, newTask, logs, factory, until } = resilienceSetup(new ScriptedDriver([failing, ok]));
  const stuck = newTask("stuck");
  const setStatus = store.setStatus.bind(store);
  store.setStatus = (id, status, ...rest) => {
    if (id === stuck.id) throw new Error("database or disk is full");
    setStatus(id, status, ...rest);
  };
  factory.start();
  await until(() => logs.some((l) => l.includes(`Couldn't record how ${stuck.id} ended`)), "the failure to be logged");
  const next = newTask("next");
  await until(() => store.getTask(next.id)!.status === "done", "the crew member to take the next task");
  await factory.stop();
  store.setStatus = setStatus;

  // What the log line promises: a restart picks the task up again.
  store.setPaused(true);
  const restarted = new Factory(store, new ScriptedDriver([ok]), { crewSize: 1, tickMs: 5 });
  restarted.start();
  assert.equal(store.getTask(stuck.id)!.status, "queued");
  await restarted.stop();
});

test("factory: a driver callback whose write fails costs that update, not the run", async () => {
  const chatty = async (ctx: RunContext): Promise<RunResult> => {
    ctx.onSession?.("s-lost");
    ctx.emit("note", "lost");
    return ok(ctx);
  };
  const { store, newTask, logs, factory, until } = resilienceSetup(new ScriptedDriver([chatty]));
  const t = newTask("x");
  const addEvent = store.addEvent.bind(store);
  store.addEvent = (...args: Parameters<Store["addEvent"]>) => {
    if (args[2] === "lost") throw new Error("database or disk is full");
    return addEvent(...args);
  };
  const updateTask = store.updateTask.bind(store);
  store.updateTask = (id, patch) => {
    if (patch.sessionId === "s-lost") throw new Error("database or disk is full");
    updateTask(id, patch);
  };
  factory.start();
  await until(() => store.getTask(t.id)!.status === "done", "the run to finish");
  await factory.stop();
  assert.equal(logs.filter((l) => l.startsWith("Couldn't record a task update")).length, 2, logs.join("\n"));
});

test("factory: a malformed CRANE_AGENTS keeps the default crew instead of benching everyone", (t) => {
  const before = process.env.CRANE_AGENTS;
  t.after(() => {
    if (before === undefined) delete process.env.CRANE_AGENTS;
    else process.env.CRANE_AGENTS = before;
  });
  process.env.CRANE_AGENTS = "lots";
  const store = newStore();
  new Factory(store, new ScriptedDriver([]));
  assert.deepEqual(["a-jib", "a-boom", "a-hoist"].map((id) => store.crewActive(id)), [true, true, false]);
});

test("factory: a transient failure is retried once, resuming the session", async () => {
  const driver = new ScriptedDriver([overloaded, ok]);
  const { task: t, events } = await runOne(driver);
  assert.equal(t.status, "done");
  assert.equal(driver.calls.length, 2);
  assert.equal(driver.calls[1]!.resumeSession, "s-1");
  assert.deepEqual(driver.calls[0]!.allowedTools, ["Bash(npm ci:*)"], "the repo's allowed commands reach the driver");
  assert.equal(driver.calls[0]!.maxTurns, 200);
  assert.ok(events.some((e) => e.message.startsWith("API Error: 529 overloaded_error. Trying once more")));
  assert.ok(Math.abs(t.costUsd - 0.4) < 1e-9, "both attempts count toward spend");
});

test("factory: a second transient failure fails the task, and keeps what both cost", async () => {
  const driver = new ScriptedDriver([overloaded, overloaded]);
  const { task: t } = await runOne(driver);
  assert.equal(t.status, "failed");
  assert.equal(driver.calls.length, 2);
  assert.ok(Math.abs(t.costUsd - 0.6) < 1e-9);
});

test("factory: other failures aren't retried", async () => {
  const driver = new ScriptedDriver([
    async () => {
      throw new AgentRunError("Stopped after 7 turns", { limit: "turns" });
    },
  ]);
  const { task: t, events } = await runOne(driver);
  assert.equal(t.status, "failed");
  assert.equal(driver.calls.length, 1);
  assert.ok(events.some((e) => e.type === "status" && e.message === "Hit the turn limit"));
});

test("factory: a stuck agent is stopped at the time limit and the slot is freed", async () => {
  const driver = new ScriptedDriver([hang]);
  const { task: t, events, store } = await runOne(driver, { timeLimitMin: 0.002 });
  assert.equal(t.status, "failed");
  assert.ok(events.some((e) => e.type === "status" && e.message === "Hit the time limit"));
  assert.ok(events.some((e) => e.type === "error" && /the most a task may run/.test(e.message)));
  assert.equal(store.listAgents()[0]!.taskId, null);
});

// ── deciding on blocked commands ────────────────────────

test("blocked: repeats add up per repo, and a decision clears them", () => {
  const store = newStore();
  const actions = new OperatorActions(store);
  const a = store.addRepo({ path: "/code/a" });
  const b = store.addRepo({ path: "/code/b" });
  const mk = (repoId: string) => store.createTask({ kind: "maintenance", title: "x", brief: "", repoId, autonomy: "observe" });
  const block = (taskId: string, rules: string[]) =>
    store.addEvent(taskId, "blocked", "Blocked", { tool: "Bash", command: "x", rules } satisfies BlockedCall);

  const t1 = mk(a.id);
  const t2 = mk(a.id);
  const t3 = mk(b.id);
  block(t1.id, ["Bash(npm ci:*)"]);
  block(t1.id, ["Bash(npm ci:*)", "Bash(make lint:*)"]);
  block(t2.id, ["Bash(npm ci:*)"]);
  block(t3.id, ["Bash(npm ci:*)"]);
  block(t3.id, []);

  const all = store.blockedTools();
  const ci = all.find((x) => x.repoId === a.id && x.rule === "Bash(npm ci:*)")!;
  assert.equal(ci.tasks, 2);
  assert.equal(ci.times, 3);
  assert.equal(ci.label, "npm ci");
  assert.equal(ci.lastTaskId, t2.id);
  assert.deepEqual(
    store.blockedTools({ minTasks: 2 }).map((x) => [x.repoId, x.rule]),
    [[a.id, "Bash(npm ci:*)"]],
    "only repeats across tasks reach the dashboard",
  );
  assert.deepEqual(
    store.blockedTools({ taskId: t2.id, repoId: a.id }).map((x) => [x.rule, x.tasks]),
    [["Bash(npm ci:*)", 2]],
    "a task sees its own rules, counted across the repo",
  );

  actions.allowTool(a.id, "npm ci", t2.id);
  assert.deepEqual(store.repoTools(a.id).allowed, ["Bash(npm ci:*)"]);
  assert.ok(!store.blockedTools().some((x) => x.repoId === a.id && x.rule === "Bash(npm ci:*)"));
  assert.ok(store.blockedTools().some((x) => x.repoId === b.id), "other repos still ask");
  assert.ok(store.listEvents(t2.id).some((e) => e.type === "operator" && e.message === `Allowed npm ci for ${a.name}`));

  actions.keepBlocked(a.id, "Bash(make lint:*)");
  assert.ok(!store.blockedTools({ repoId: a.id }).length);
  assert.equal(store.overview({ running: false, paused: false, driver: "x", factoryOutdated: false, uiOutdated: false, uiBuild: null, uiCommit: null }).blocked.length, 0);

  actions.disallowTool(a.id, "npm ci");
  assert.deepEqual(store.repoTools(a.id).allowed, []);
  store.close();
});

test("blocked: Crane's deny list can't be allowed, and neither can every command", () => {
  const store = newStore();
  const actions = new OperatorActions(store);
  const a = store.addRepo({ path: "/code/a" });
  assert.throws(() => actions.allowTool(a.id, "git push"), /never allowed/);
  assert.throws(() => actions.allowTool(a.id, "Bash(git:*)"), /never allowed/);
  assert.throws(() => actions.allowTool(a.id, "rm -rf"), /never allowed/);
  assert.throws(() => actions.allowTool(a.id, "Bash"), /every command/);
  assert.throws(() => actions.allowTool(a.id, "Bash(*)"), /every command/);
  assert.equal(toRule("npm ci"), "Bash(npm ci:*)");
  assert.equal(toRule("WebFetch"), "WebFetch");
  assert.deepEqual(store.repoTools(a.id).allowed, []);
  store.close();
});
