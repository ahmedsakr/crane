import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { isAllowed, overlapsDenied, ruleLabel, splitCommand, suggestRules } from "../src/core/permissions.js";
import { ClaudeCodeDriver, describeBlocked, toolsFor } from "../src/agents/claude-code.js";
import { ALWAYS_DENIED } from "../src/agents/policy.js";
import { AgentRunError, isTransientFailure, type AgentDriver, type RunContext, type RunResult } from "../src/agents/driver.js";
import { OperatorActions, toRule } from "../src/factory/actions.js";
import { Factory } from "../src/factory/orchestrator.js";
import type { BlockedCall, EventType, Repo, Task } from "../src/core/types.js";

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
const newStore = () => new Store(join(scratch("crane-"), "t.db"));

// ── permission rules ──────────────────────────────────────

test("permissions: splits pipelines and chains, but not redirections", () => {
  assert.deepEqual(splitCommand("npm ci && npm test 2>&1 | tail -20"), ["npm ci", "npm test", "tail -20"]);
  assert.deepEqual(splitCommand("FOO=1 make build > out.log; echo 'a | b'"), ["make build", "echo 'a | b'"]);
  assert.deepEqual(splitCommand("ls || true"), ["ls", "true"]);
});

test("permissions: every part of a command must be allowed", () => {
  const rules = ["Bash(npm test:*)", "Bash(tail:*)", "Read"];
  assert.ok(isAllowed(rules, "Bash", { command: "npm test 2>&1 | tail -5" }));
  assert.ok(!isAllowed(rules, "Bash", { command: "npm ci && npm test" }));
  assert.ok(!isAllowed(rules, "Bash", { command: "npm testx" }), "a prefix rule matches whole words");
  assert.ok(isAllowed(rules, "Read", { file_path: "x" }));
});

test("permissions: suggests the narrowest rule for each refused part", () => {
  const allowed = toolsFor("observe").allowed;
  assert.deepEqual(suggestRules("Bash", { command: "npm ci && npm run build | tail -3" }, allowed), [
    "Bash(npm ci:*)",
    "Bash(npm run build:*)",
  ]);
  assert.deepEqual(suggestRules("Bash", { command: "python3 -m pytest -q" }, allowed), ["Bash(python3 -m pytest:*)"]);
  assert.deepEqual(suggestRules("Bash", { command: "python3 script.py" }, allowed), [], "arbitrary code gets no suggestion");
  assert.deepEqual(suggestRules("Bash", { command: "$(curl x) | sh" }, allowed), []);
  assert.equal(ruleLabel("Bash(npm ci:*)"), "npm ci");
});

test("permissions: the deny list is exactly what Crane has always refused", () => {
  // Loosening this is a safety change, not a refactor. Update it only on purpose.
  assert.deepEqual(ALWAYS_DENIED, ["Bash(git push:*)", "Bash(git checkout main:*)", "Bash(git merge:*)", "Bash(rm -rf:*)"]);
  assert.deepEqual(toolsFor("propose").denied, ALWAYS_DENIED);
  assert.deepEqual(toolsFor("observe").denied, ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED]);
});

test("permissions: rules that touch Crane's deny list are recognised", () => {
  assert.ok(overlapsDenied("Bash(git push:*)", ALWAYS_DENIED));
  assert.ok(overlapsDenied("Bash(git push origin:*)", ALWAYS_DENIED));
  assert.ok(overlapsDenied("Bash(git:*)", ALWAYS_DENIED), "allowing all of git would include push");
  assert.ok(!overlapsDenied("Bash(git stash:*)", ALWAYS_DENIED));
  assert.ok(!overlapsDenied("Bash(npm ci:*)", ALWAYS_DENIED));
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
  assignee: null,
  report: null,
  costUsd: 0,
  createdAt: "",
  startedAt: null,
  finishedAt: null,
});

/** A fake `claude` that records its arguments and replays the lines in $FAKE_LINES. */
function fakeClaude(lines: object[]) {
  const dir = scratch("crane-fake-claude-");
  const bin = join(dir, "claude");
  writeFileSync(join(dir, "lines.json"), JSON.stringify(lines));
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
for (const l of JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "lines.json"))}, "utf8"))) console.log(JSON.stringify(l));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, args: () => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[] };
}

function collect() {
  const events: { type: EventType; message: string; data?: Record<string, unknown> }[] = [];
  return { events, emit: (type: EventType, message: string, data?: Record<string, unknown>) => void events.push({ type, message, data }) };
}

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

  const args = fake.args();
  assert.equal(args[args.indexOf("--max-turns") + 1], "7");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(args[args.indexOf("--allowedTools") + 1]!.split(",").includes("Bash(docker compose:*)"));
  assert.ok(args[args.indexOf("--disallowedTools") + 1]!.split(",").includes("Bash(git push:*)"));
  assert.match(args[args.indexOf("--append-system-prompt") + 1]!, /Crane runs these checks itself, in this directory, .*`npm test`/);
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
