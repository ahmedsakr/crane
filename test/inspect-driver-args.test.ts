import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_DENIED, classifyToolCall } from "@crane/agent-policy";
import type { RunContext } from "@crane/agent-protocol";
import type { Task } from "@crane/contracts";
import { claudeArgs, permissionMode, toolsFor } from "../packages/agent-drivers/src/claude-code.js";
import { guardForRun } from "../packages/agent-drivers/src/claude-guard.js";
import { decodeGuardContext, hookDecision } from "../packages/agent-drivers/src/command-guard-protocol.js";
import { ClaudeStream } from "../packages/agent-drivers/src/claude-stream.js";
import { resumePrompt, systemPrompt } from "../packages/agent-drivers/src/prompts.js";

const task: Task = {
  id: "t-i", kind: "maintenance", title: "Inspect", brief: "Inspect", repoId: "r-i", autonomy: "observe", status: "running",
  agentId: null, branch: null, worktree: null, sessionId: null, driver: null, model: null, effort: null, driverSettings: null,
  assignee: null, postmortemOf: null, preApprovedAt: null, prerequisites: [], prerequisitesWaivedAt: null, acceptance: [],
  acceptanceChecks: [], lookouts: [], report: null, costUsd: 0, createdAt: "", createdBy: null, scheduledAt: null,
  scheduleId: null, followUpOf: null, followUpFinding: null, startedAt: null, finishedAt: null,
};
const ctx: RunContext = {
  task, repo: { id: "r-i", name: "app", path: "/code/app", defaultBranch: "main", isFactory: false, addedAt: "" },
  cwd: "/code/app", signal: new AbortController().signal, emit: () => {},
};
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

test("inspect args: all three modes preserve the read-only baseline and write denies, without broad Bash or auto mode", () => {
  const tools = toolsFor("observe");
  for (const commandAccess of ["listed", "most", "auto"] as const) {
    const run = { ...ctx, commandAccess };
    const guard = guardForRun(run, []);
    const args = claudeArgs(run, "observe", tools, undefined, guard);
    assert.deepEqual(after(args, "--allowedTools").split(","), tools.allowed, commandAccess);
    assert.deepEqual(after(args, "--disallowedTools").split(","), ["Edit", "Write", "MultiEdit", "NotebookEdit", ...ALWAYS_DENIED]);
    assert.ok(!tools.allowed.some((rule) => ["Bash", "Bash(*)", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(rule)));
    assert.equal(after(args, "--permission-mode"), commandAccess === "listed" ? "default" : "manual");
    assert.ok(!args.includes("--permission-prompts") && !args.includes("bypassPermissions"));
    assert.equal(permissionMode("observe", { ...guard!, access: "auto" }), "manual", "observe wins even if passed an auto guard");
    if (commandAccess === "listed") {
      assert.equal(guard, undefined);
      assert.ok(!args.includes("--settings") && !args.includes("--include-hook-events"));
      continue;
    }
    const settings = JSON.parse(after(args, "--settings"));
    assert.equal(settings.autoMode, undefined, "no classifier settings for observe");
    const hook = settings.hooks.PreToolUse[0];
    assert.equal(hook.matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit");
    assert.ok(args.includes("--include-hook-events"));
    const context = decodeGuardContext(hook.hooks[0].command.split(" ").at(-1));
    assert.equal(context.profile, "inspect");
    assert.equal(context.access, commandAccess);
    assert.equal(context.worktree, ctx.cwd);
    assert.equal(context.checkout, ctx.repo!.path);
    const verdict = classifyToolCall({ tool: "Bash", input: { command: "git log --oneline | head -20" } }, context);
    assert.equal(hookDecision(verdict, context.access, context.profile)?.hookSpecificOutput.permissionDecision, "allow");
  }
});

test("inspect args: listed mode and unspecified access retain the previous arguments and prompt", () => {
  const tools = toolsFor("observe");
  assert.equal(guardForRun(ctx, []), undefined);
  assert.deepEqual(claudeArgs(ctx, "observe", tools), claudeArgs({ ...ctx, commandAccess: "listed" }, "observe", tools));
  for (const access of ["most", "auto"] as const) {
    const opts = { commandAccess: access };
    for (const prompt of [systemPrompt(task, ctx.repo, undefined, opts), resumePrompt(ctx, opts)]) {
      assert.match(prompt, /Read-only inspection commands on Crane's positive list are allowed/);
      assert.match(prompt, /Everything else stays blocked/);
      assert.doesNotMatch(prompt, /Most commands are allowed in this worktree/);
      assert.match(prompt, /A guard refusal is final/);
    }
    assert.equal(systemPrompt(task, ctx.repo, undefined, { ...opts, sandboxed: true }), systemPrompt(task, ctx.repo, undefined, { sandboxed: true }));
  }
});

test("inspect stream: an auto repo never produces classifier-unavailable notes for an inspection run", () => {
  const events: string[] = [];
  const run = { ...ctx, commandAccess: "auto" as const, emit: (_type: string, message: string) => void events.push(message) };
  const stream = new ClaudeStream(run, toolsFor("observe"), undefined, guardForRun(run, []));
  stream.handle({ type: "system", subtype: "init", session_id: "inspect", permissionMode: "default" });
  assert.ok(!events.some((event) => event.includes("Auto mode wasn't available")));
});
