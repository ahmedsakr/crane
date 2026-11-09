import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyToolCall, overlapsDenied, ALWAYS_DENIED, type GuardContext } from "@crane/agent-policy";
import type { AgentJob } from "@crane/agent-protocol";
import type { BlockedCall, EventType } from "@crane/contracts";
import { ClaudeStream, describeBlocked } from "../packages/agent-drivers/src/claude-stream.js";
import { toolsFor } from "../packages/agent-drivers/src/claude-code.js";
import { GUARD_DENY_PREFIX, hookDecision } from "../packages/agent-drivers/src/command-guard-protocol.js";
import { BLOCKED_BRIEF } from "../packages/agent-drivers/src/prompt-briefs.js";
import { resumePrompt, systemPrompt } from "../packages/agent-drivers/src/prompts.js";
import { Store } from "@crane/storage";
import { OperatorActions } from "../src/factory/actions.js";

const context: GuardContext = {
  access: "most", profile: "worktree", worktree: "/factory/worktrees/task", checkout: "/code/app",
  defaultBranch: "main", craneHome: "/factory", home: "/home/operator", allowed: [],
};

function harness(guard: GuardContext = context) {
  const events: { type: EventType; data?: Record<string, unknown> }[] = [];
  const stream = new ClaudeStream({
    signal: new AbortController().signal,
    emit: (type, _message, data) => void events.push({ type, data }),
  }, toolsFor("propose"), undefined, guard);
  const blocked = () => events.filter(e => e.type === "blocked").map(e => e.data as unknown as BlockedCall);
  return { stream, blocked };
}

function refusalMessages(command: string, guard: GuardContext = context) {
  const verdict = classifyToolCall({ tool: "Bash", input: { command } }, guard);
  const reason = hookDecision(verdict, guard.access)!.hookSpecificOutput.permissionDecisionReason;
  return { verdict, reason, messages: [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true,
      content: `PreToolUse:Bash hook error: ${reason}` }] } },
    { type: "result", subtype: "success", result: "Done", permission_denials: [
      { tool_name: "Bash", tool_use_id: "call-1", tool_input: { command } },
    ] },
  ] };
}

test("guard refusals: live marker keeps the reason, category and classifier rules across summary duplicates", () => {
  for (const command of ["npm install -g typescript", "npm publish", "crane approve t-example", "git branch -f main HEAD"]) {
    const { stream, blocked } = harness();
    const { verdict, reason, messages } = refusalMessages(command);
    for (const msg of messages) stream.handle(msg);
    assert.equal(blocked().length, 1, command);
    assert.deepEqual(blocked()[0], {
      tool: "Bash", command, toolUseId: "call-1", rules: verdict.rules,
      refusal: { source: "crane.guard", reason: reason.slice(GUARD_DENY_PREFIX.length).trim() },
      guard: { category: verdict.category, overridable: verdict.overridable },
    });
    assert.ok(blocked()[0]!.refusal!.reason!.includes(verdict.reason));
  }
});

test("guard refusals: hard evidence cannot acquire heuristic or explicitly supplied rules", () => {
  const data = describeBlocked("Bash", { command: "crane approve t-example" }, toolsFor("propose"), {
    refusal: { source: "crane.guard", reason: "x".repeat(5000) },
    guard: { category: "operator-actions", overridable: false }, rules: ["Bash(crane approve:*)"],
  }).data;
  assert.deepEqual(data.rules, []);
  assert.equal(data.refusal!.reason!.length, 4000);
});

test("guard refusals: hook failure markers carry evidence but never offer an allow rule", () => {
  const { stream, blocked } = harness();
  stream.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "fail", name: "Bash", input: { command: "npm publish" } }] } });
  stream.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fail", is_error: true,
    content: `PreToolUse:Bash hook error: ${GUARD_DENY_PREFIX} the guard couldn't check this call` }] } });
  assert.deepEqual(blocked()[0]!.guard, { category: "guard-error", overridable: false });
  assert.deepEqual(blocked()[0]!.rules, []);
  assert.equal(blocked()[0]!.refusal!.source, "crane.guard");
});

test("guard refusals: file-tool text blocks keep a readable, bounded guard reason", () => {
  const { stream, blocked } = harness();
  const reason = "Outside the worktree. ".repeat(300);
  stream.handle({ type: "assistant", message: { content: [{ type: "tool_use", id: "write", name: "Write", input: { file_path: "/code/app/file.ts" } }] } });
  stream.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "write", is_error: true,
    content: [{ type: "text", text: `PreToolUse:Write hook error: ${GUARD_DENY_PREFIX} ${reason}` }] }] } });
  assert.equal(blocked()[0]!.refusal!.reason, reason.slice(0, 4000));
  assert.deepEqual(blocked()[0]!.guard, { category: "outside-worktree", overridable: false });
  assert.deepEqual(blocked()[0]!.rules, []);
});

test("guard refusals: Claude Code denials and ordinary command errors keep their existing meaning", () => {
  const { stream, blocked } = harness();
  for (const [id, text] of [["own", "This command requires approval"], ["error", "Permission denied"]]) {
    stream.handle({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "docker compose up" } }] } });
    stream.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
  }
  stream.handle({ type: "result", subtype: "success", permission_denials: [
    { tool_name: "Bash", tool_use_id: "own", tool_input: { command: "docker compose up" } },
    { tool_name: "Bash", tool_use_id: "summary", tool_input: { command: "docker compose down" } },
  ] });
  assert.equal(blocked().length, 2);
  assert.deepEqual(blocked()[0]!.refusal, { source: "claude-code.tool_result", reason: "This command requires approval" });
  assert.deepEqual(blocked()[1]!.refusal, { source: "claude-code.permission_denials", reason: null });
  assert.deepEqual(blocked()[0]!.rules, ["Bash(docker compose:*)"]);
  assert.equal(blocked()[0]!.guard, undefined);
});

test("guard refusals: two tasks surface only overridable rules, and operator Allow changes the next run", () => {
  const store = new Store(":memory:");
  try {
    const repo = store.addRepo({ path: context.checkout, name: "app" });
    const actions = new OperatorActions(store);
    actions.setCommandAccess(repo.id, "most");
    for (let i = 0; i < 2; i++) {
      const task = store.createTask({ kind: "maintenance", title: "Guarded", brief: "", autonomy: "propose", repoId: repo.id });
      for (const command of ["npm install -g typescript", "crane approve t-example"]) {
        const { stream, blocked } = harness();
        for (const msg of refusalMessages(command).messages) stream.handle(msg);
        store.addEvent(task.id, "blocked", "Blocked", { ...blocked()[0]! });
      }
    }
    const suggestions = store.blockedTools({ repoId: repo.id, minTasks: 2 });
    assert.deepEqual(suggestions.map(s => [s.rule, s.tasks]), [["Bash(npm install:*)", 2]]);
    assert.equal(store.blockedTools().length, 1, "crane blocked uses the same reader without minTasks");
    for (const suggestion of suggestions) {
      assert.equal(overlapsDenied(suggestion.rule, ALWAYS_DENIED), false);
      actions.allowTool(repo.id, suggestion.rule);
    }
    assert.deepEqual(store.blockedTools(), []);
    const next = { ...context, allowed: store.repoTools(repo.id).allowed };
    assert.equal(classifyToolCall({ tool: "Bash", input: { command: "npm install -g typescript" } }, next).decision, "allow");
    assert.equal(classifyToolCall({ tool: "Bash", input: { command: "crane approve t-example" } }, next).decision, "deny");
  } finally { store.close(); }
});

test("guard prompts: most, listed and auto guidance reaches work, conflicts, fixes and resumes", () => {
  const store = new Store(":memory:");
  try {
    const task = store.createTask({ kind: "maintenance", title: "Guarded", brief: "", autonomy: "propose", repoId: null });
    const jobs: (AgentJob | undefined)[] = [undefined,
      { kind: "resolve_conflicts", phase: "edit", base: "main", files: ["a.ts"] },
      { kind: "resolve_conflicts", phase: "validate", checkpoint: "saved", base: "main", files: ["a.ts"] },
      { kind: "fix_checks", base: "main", commit: "saved", failures: [] },
    ];
    for (const commandAccess of ["most", "listed", "auto"] as const) {
      const opts = { commandAccess };
      for (const job of jobs) {
        for (const prompt of [systemPrompt(task, null, job, opts), resumePrompt({ task, job }, opts)]) {
          if (commandAccess !== "listed") {
            assert.match(prompt, /Most commands are allowed in this worktree/);
            assert.match(prompt, commandAccess === "most" ? /A guard refusal is final/ : /An auto-mode block is final just like a guard refusal/);
            assert.match(prompt, /don't retry it rewritten, through a script, another interpreter/);
            assert.match(prompt, /pushing, merging, moving shared branches/);
            assert.match(prompt, /operator actions such as approving tasks, publishing or deploying/);
            assert.doesNotMatch(prompt, /Some commands are not allowed/);
            if (commandAccess === "most") assert.doesNotMatch(prompt, /auto mode/i);
            else assert.match(prompt, /Claude Code's auto mode also reviews the commands/);
          } else {
            assert.ok(prompt.includes(BLOCKED_BRIEF));
            assert.match(prompt, /guard also refuses operator actions and shared-branch changes/);
          }
        }
        const codex = { agentCommits: false, sandboxed: true };
        assert.equal(systemPrompt(task, null, job, codex), systemPrompt(task, null, job, { ...codex, commandAccess }));
        assert.equal(resumePrompt({ task, job }), resumePrompt({ task, job }, { ...codex, commandAccess }));
      }
    }
    for (const file of ["prompts.ts", "prompt-briefs.ts"]) {
      const source = readFileSync(new URL(`../packages/agent-drivers/src/${file}`, import.meta.url), "utf8");
      assert.ok(source.trimEnd().split("\n").length < 500, file);
    }
  } finally { store.close(); }
});
