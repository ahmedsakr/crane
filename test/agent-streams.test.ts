import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRunError, type RunContext } from "@crane/agent-protocol";
import type { AgentStream } from "../packages/agent-drivers/src/agent-process.js";
import { SessionNotResumed } from "../packages/agent-drivers/src/agent-process.js";
import { ClaudeStream } from "../packages/agent-drivers/src/claude-stream.js";
import { CodexStream } from "../packages/agent-drivers/src/codex-stream.js";
import { CLAUDE_FRESH_RUN, CODEX_THREAD_START, codexWork } from "./support/fake-agents.js";

const TOOLS = { allowed: ["Read"], denied: ["Bash(git push:*)"] };
const CWD = "/work/tree";
const CLEAN_EXIT = { code: 0, stderr: "" };

interface Recorded {
  type: string;
  message: string;
  data?: Record<string, any>;
}

function harness(overrides: Partial<Pick<RunContext, "effort" | "maxTurns">> = {}) {
  const events: Recorded[] = [];
  const sessions: string[] = [];
  const usage: { costUsd: number; inputTokens: number; turns: number }[] = [];
  const controller = new AbortController();
  const ctx = {
    cwd: CWD,
    signal: controller.signal,
    emit: (type: string, message: string, data?: Record<string, unknown>) => void events.push({ type, message, data }),
    onSession: (id: string) => void sessions.push(id),
    onUsage: (u: { costUsd: number; inputTokens: number; turns: number }) => void usage.push(u),
    ...overrides,
  };
  return { ctx, events, sessions, usage, controller, messages: () => events.map((e) => e.message) };
}

function replay(stream: AgentStream, messages: object[]) {
  for (const msg of messages) stream.handle(msg as Record<string, unknown>);
}

/** Finish the stream, returning what it threw. */
function finishError(stream: AgentStream, exit: { code: number | null; stderr: string } = CLEAN_EXIT): unknown {
  try {
    stream.finish(exit);
  } catch (err) {
    return err;
  }
  return assert.fail("expected the run to fail");
}

function bash(id: string, command: string) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } };
}

function toolResult(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } };
}

test("claude stream: a recorded run gives its session, usage and report", () => {
  const h = harness({ effort: "high" });
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, CLAUDE_FRESH_RUN);
  assert.deepEqual(h.sessions, ["fresh-session"]);
  assert.deepEqual(h.events, [{ type: "note", message: "Agent session started on fake, high effort", data: { sessionId: "fresh-session" } }]);
  assert.equal(h.usage[0]!.costUsd, 0.25);
  assert.equal(stream.finish(CLEAN_EXIT).report.summary, "All good");
});

test("claude stream: text stops at the report, and tools are described", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [{
    type: "assistant",
    message: { content: [
      { type: "text", text: "Looking.\n\n```crane-report\n{}\n```" },
      { type: "text", text: "```crane-report\n{}\n```" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
    ] },
  }]);
  assert.deepEqual(h.events, [
    { type: "note", message: "Looking.", data: { routine: true } },
    { type: "tool", message: "Read a.ts", data: { tool: "Read", toolUseId: "t1", sessionId: null } },
  ]);
});

test("claude stream: a command's outcome is recorded, and one with no exit code qualifies the report", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [
    bash("b1", "npm test\nsecond line"),
    toolResult("b1", "ok", { is_error: false }),
    { type: "result", subtype: "success", result: "Finished." },
  ]);
  assert.deepEqual(h.messages(), ["Ran npm test", "Bash returned a result", "Command unknown npm test"]);
  const { summary } = stream.finish(CLEAN_EXIT).report;
  assert.match(summary, /^Finished\.\n\nClaude command validation evidence: 1 Bash command\(s\)/);
});

test("claude stream: a command's status comes from what its result says", () => {
  for (const [extra, metadata, status] of [
    [{ is_error: true }, { exit_code: 2 }, "failed"],
    [{ is_error: false }, { exit_code: 0 }, "completed"],
    [{ is_error: false }, { interrupted: true }, "interrupted"],
  ] as const) {
    const h = harness();
    const stream = new ClaudeStream(h.ctx, TOOLS);
    replay(stream, [bash("b1", "npm test"), { ...toolResult("b1", "x", extra), tool_use_result: metadata }]);
    assert.equal(h.events.at(-1)!.data!.command.status, status);
  }
});

test("claude stream: metadata isn't assigned to one of several parallel results", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [bash("b1", "one"), bash("b2", "two"), {
    type: "user",
    tool_use_result: { exit_code: 0 },
    message: { content: [
      { type: "tool_result", tool_use_id: "b1", content: "x" },
      { type: "tool_result", tool_use_id: "b2", content: "y" },
    ] },
  }]);
  const exits = h.events.filter((e) => e.data?.result).map((e) => e.data!.result.exitCode);
  assert.deepEqual(exits, [null, null]);
});

test("claude stream: a refusal is reported once, from whichever record comes first", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [
    bash("b1", "curl example.com"),
    toolResult("b1", "This command requires approval", { is_error: true }),
    { type: "result", subtype: "success", result: "Done", permission_denials: [
      { tool_use_id: "b1", tool_name: "Bash", tool_input: { command: "curl example.com" } },
      { tool_name: "Write", tool_input: { file_path: "x.ts" } },
    ] },
  ]);
  const blocked = h.events.filter((e) => e.type === "blocked");
  assert.deepEqual(blocked.map((e) => e.message), ["Blocked: curl example.com", "Blocked: Write x.ts"]);
  assert.equal(blocked[0]!.data!.refusal.source, "claude-code.tool_result");
  assert.equal(blocked[0]!.data!.refusal.reason, "This command requires approval");
  assert.deepEqual(blocked[1]!.data!.refusal, { source: "claude-code.permission_denials", reason: null });
  assert.equal(blocked[1]!.data!.toolUseId, "denial-1");
});

test("claude stream: running out of turns is a limit, not a transient failure, and still reports usage", () => {
  const h = harness({ maxTurns: 7 });
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [...CLAUDE_FRESH_RUN.slice(0, 1), { type: "result", subtype: "error_max_turns", total_cost_usd: 1, session_id: "later" }]);
  assert.equal(h.usage.length, 1, "reported before the run is judged");
  const err = finishError(stream) as AgentRunError;
  assert.ok(err instanceof AgentRunError);
  assert.match(err.message, /^Stopped after 7 turns/);
  assert.equal(err.opts.limit, "turns");
  assert.equal(err.transient, false);
  assert.equal(err.sessionId, "later");
});

test("claude stream: an error result prefers its own text, then its errors, then its subtype", () => {
  for (const [result, message] of [
    [{ is_error: true, result: "API Error: 529 overloaded_error" }, "API Error: 529 overloaded_error"],
    [{ subtype: "error_during_execution", errors: ["one", "two"] }, "one; two"],
    [{ subtype: "error_during_execution" }, "Agent stopped: error_during_execution"],
    [{ is_error: true }, "Agent stopped: error"],
  ] as const) {
    const stream = new ClaudeStream(harness().ctx, TOOLS);
    replay(stream, [{ type: "result", ...result }]);
    const err = finishError(stream) as AgentRunError;
    assert.equal(err.message, message);
    assert.equal(err.transient, /overloaded/.test(message));
  }
});

test("claude stream: a failed exit with no result fails, with the end of stderr", () => {
  const stream = new ClaudeStream(harness().ctx, TOOLS);
  replay(stream, CLAUDE_FRESH_RUN.slice(0, 1));
  const err = finishError(stream, { code: 3, stderr: `${"x".repeat(600)}boom\n` }) as AgentRunError;
  assert.ok(err instanceof AgentRunError);
  assert.equal(err.message, `Claude Code exited with code 3. ${"x".repeat(496)}boom`);
  assert.equal(err.sessionId, "fresh-session");
});

test("claude stream: a resume that never started isn't a run failure", () => {
  const stream = new ClaudeStream(harness().ctx, TOOLS, "old");
  assert.throws(() => stream.finish({ code: 1, stderr: "No conversation found\n" }), (err: Error) =>
    err instanceof SessionNotResumed && err.message === "No conversation found");
  const silent = new ClaudeStream(harness().ctx, TOOLS, "old");
  assert.throws(() => silent.finish({ code: 1, stderr: "" }), (err: Error) => err instanceof SessionNotResumed && err.message === "exit code 1");
});

test("claude stream: a cancelled run closes open commands as interrupted", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS, "old");
  replay(stream, [bash("b1", "npm test")]);
  h.controller.abort();
  const err = finishError(stream) as AgentRunError;
  assert.equal(err.message, "Cancelled by operator");
  assert.equal(err.sessionId, "old");
  assert.equal(h.events.at(-1)!.message, "Command interrupted npm test");
});

test("claude stream: a process error closes open commands, and they aren't closed twice", () => {
  const h = harness();
  const stream = new ClaudeStream(h.ctx, TOOLS);
  replay(stream, [bash("b1", "npm test")]);
  stream.onProcessError();
  assert.equal(h.events.at(-1)!.message, "Command unknown npm test");
  const emitted = h.events.length;
  stream.finish(CLEAN_EXIT);
  assert.equal(h.events.length, emitted);
});

test("codex stream: a recorded run gives its session, events, usage and report", () => {
  const h = harness({ effort: "high" });
  const stream = new CodexStream(h.ctx, "gpt-5-codex");
  replay(stream, [...CODEX_THREAD_START, ...codexWork(CWD)]);
  assert.deepEqual(h.sessions, ["thread-1"]);
  assert.deepEqual(h.messages(), [
    "Agent session started on Codex (gpt-5-codex, high effort)",
    "Started npm test",
    "Command completed npm test (exit 0)",
    "Edited src/a.ts",
    "Wrote src/b.ts",
    "Fixed it.",
  ]);
  assert.equal(h.usage.length, 0, "usage waits for the end of the run");
  const { report } = stream.finish(CLEAN_EXIT);
  assert.equal(report.summary, "Codex did it");
  assert.equal(report.findings[0]!.title, "One thing");
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0]!.inputTokens, 400);
});

test("codex stream: usage adds up across turns", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null);
  const turn = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } };
  replay(stream, [...CODEX_THREAD_START, turn, turn]);
  stream.finish(CLEAN_EXIT);
  assert.equal(h.usage[0]!.inputTokens, 20);
  assert.equal(h.usage[0]!.turns, 2);
});

test("codex stream: each item type is told at the right phase", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null);
  const items = [
    { type: "web_search", query: "docs" },
    { type: "mcp_tool_call", server: "s", tool: "t" },
    { type: "mcp_tool_call" },
    { type: "todo_list" },
  ];
  replay(stream, items.map((item) => ({ type: "item.completed", item })));
  assert.deepEqual(h.events, [], "these are told when they start");
  replay(stream, items.map((item) => ({ type: "item.started", item })));
  assert.deepEqual(h.messages(), ["Searched the web for “docs”", "s: t", "mcp: tool", "Updated its plan"]);
});

test("codex stream: file changes name what happened, relative to the worktree", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null);
  const item = { type: "file_change", changes: [
    { path: `${CWD}/a.ts`, kind: "add" },
    { path: `${CWD}/b.ts`, kind: "delete" },
    { path: "/elsewhere/c.ts", kind: "update" },
  ] };
  replay(stream, [{ type: "item.started", item }, { type: "item.completed", item }]);
  assert.deepEqual(h.messages(), ["Wrote a.ts", "Deleted b.ts", "Edited /elsewhere/c.ts"]);
});

test("codex stream: a surprising message throws for readMessages to contain, and costs only itself", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null);
  assert.throws(() => stream.handle({ type: "item.completed", item: { type: "file_change", changes: 5 } }));
  replay(stream, codexWork(CWD));
  assert.equal(stream.finish(CLEAN_EXIT).report.summary, "Codex did it");
});

test("codex stream: a failed turn fails the run, after reporting what it used", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null);
  replay(stream, [...CODEX_THREAD_START, { type: "turn.completed", usage: {} }, { type: "turn.failed", error: { message: "API Error: 529 overloaded_error" } }]);
  const err = finishError(stream, { code: 1, stderr: "" }) as AgentRunError;
  assert.equal(err.message, "API Error: 529 overloaded_error");
  assert.equal(err.transient, true);
  assert.equal(err.sessionId, "thread-1");
  assert.equal(h.usage.length, 1);
});

test("codex stream: a stream error only fails a run with no completed turn", () => {
  const retried = { type: "error", message: "Reconnecting" };
  const recovered = new CodexStream(harness().ctx, null);
  replay(recovered, [...CODEX_THREAD_START, retried, ...codexWork(CWD)]);
  assert.equal(recovered.finish(CLEAN_EXIT).report.summary, "Codex did it");
  const fatal = new CodexStream(harness().ctx, null);
  replay(fatal, [...CODEX_THREAD_START, retried]);
  assert.equal((finishError(fatal) as Error).message, "Reconnecting");
});

test("codex stream: a lost stream never implies success", () => {
  const silent = finishError(new CodexStream(harness().ctx, null)) as Error;
  assert.match(silent.message, /^Codex finished without sending any events Crane understands/);
  const crashed = finishError(new CodexStream(harness().ctx, null), { code: 2, stderr: "segfault\n" }) as Error;
  assert.equal(crashed.message, "Codex exited with code 2. segfault");
  const started = new CodexStream(harness().ctx, null);
  replay(started, CODEX_THREAD_START);
  assert.equal((finishError(started, { code: 137, stderr: "" }) as Error).message, "Codex exited with code 137. ");
});

test("codex stream: a resume that never started prefers what the stream said", () => {
  for (const [messages, expected] of [
    [[{ type: "error", message: "No saved session found" }], "No saved session found"],
    [[{ type: "turn.failed", error: {} }, { type: "error", message: "later" }], "The agent stopped with an error"],
    [[], "exit code 1"],
  ] as const) {
    const stream = new CodexStream(harness().ctx, null, "old");
    replay(stream, [...messages]);
    assert.throws(() => stream.finish({ code: 1, stderr: "" }), (err: Error) => err instanceof SessionNotResumed && err.message === expected);
  }
});

test("codex stream: a cancelled run reports usage, then closes open commands as interrupted", () => {
  const h = harness();
  const stream = new CodexStream(h.ctx, null, "old");
  replay(stream, [
    { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc 'sleep 9'" } },
    { type: "turn.completed", usage: {} },
  ]);
  h.controller.abort();
  const err = finishError(stream) as AgentRunError;
  assert.equal(err.message, "Cancelled by operator");
  assert.equal(err.sessionId, "old");
  assert.equal(h.usage.length, 1);
  assert.equal(h.events.at(-1)!.message, "Command interrupted sleep 9");
});
