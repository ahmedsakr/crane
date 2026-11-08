import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeDriver } from "@crane/agent-drivers";
import { ALWAYS_DENIED, classifyToolCall, type GuardContext } from "@crane/agent-policy";
import type { AgentJob, RunContext } from "@crane/agent-protocol";
import type { CommandAccess, EventType, Repo, Task } from "@crane/contracts";
import { decodeGuardContext, hookDecision, GUARD_DENY_PREFIX } from "../packages/agent-drivers/src/command-guard-protocol.js";
import { guardHookPath } from "../packages/agent-drivers/src/claude-guard.js";
import { CLAUDE_FRESH_RUN, fakeClaude } from "./support/fake-agents.js";

const repo: Repo = { id: "r-g", name: "app", path: "/code/app", defaultBranch: "trunk", isFactory: false, addedAt: "" };
const task = (autonomy: Task["autonomy"]): Task => ({
  id: "t-g", kind: "maintenance", title: "Guarded", brief: "Guarded", repoId: repo.id, autonomy, status: "running",
  agentId: null, branch: null, worktree: null, sessionId: null, driver: null, model: null, effort: null, driverSettings: null,
  assignee: null, postmortemOf: null, preApprovedAt: null, prerequisites: [], prerequisitesWaivedAt: null, acceptance: [],
  acceptanceChecks: [], lookouts: [], report: null, costUsd: 0, createdAt: "", createdBy: null, scheduledAt: null,
  scheduleId: null, followUpOf: null, followUpFinding: null, startedAt: null, finishedAt: null,
});
const JOBS: Record<string, AgentJob> = {
  resolve: { kind: "resolve_conflicts", base: "origin/trunk", files: ["src/a.ts"] },
  fix: { kind: "fix_checks", base: "origin/trunk", commit: "abc123", failures: [{ command: "npm test", exitCode: 1, logs: "1 failing" }] },
};

interface Run {
  args: string[];
  events: { type: EventType; message: string; data?: Record<string, unknown> }[];
  cwd: string;
}

async function runDriver(autonomy: Task["autonomy"], extra: Partial<RunContext> = {}, lines: object[] = CLAUDE_FRESH_RUN): Promise<Run> {
  const fake = fakeClaude(lines);
  const cwd = mkdtempSync(join(tmpdir(), "crane-guard-cwd-"));
  const events: Run["events"] = [];
  await new ClaudeCodeDriver(fake.bin).run({
    task: task(autonomy), repo, cwd, signal: new AbortController().signal,
    emit: (type, message, data) => void events.push({ type, message, data }),
    ...extra,
  });
  return { args: fake.args(), events, cwd };
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

function hookOf(args: string[]): { matcher: string; command: string; timeout: number } {
  const settings = JSON.parse(after(args, "--settings"));
  const [entry, ...others] = settings.hooks.PreToolUse;
  assert.equal(others.length, 0);
  assert.equal(entry.hooks.length, 1);
  return { matcher: entry.matcher, command: entry.hooks[0].command, timeout: entry.hooks[0].timeout };
}

const contextOf = (args: string[]): GuardContext => decodeGuardContext(hookOf(args).command.split(" ").at(-1));

test("guard: stand-in CLI records guard and Claude refusals once, with classifier suggestions", async () => {
  const guard: GuardContext = {
    access: "most", profile: "worktree", worktree: "/work/task", checkout: repo.path,
    defaultBranch: repo.defaultBranch, craneHome: "/factory", home: homedir(), allowed: [],
  };
  const calls = ["npm install -g typescript", "crane approve t-example", "docker compose up"];
  const reasons = calls.map((command, i) => {
    if (i === 2) return "This command requires approval";
    return hookDecision(classifyToolCall({ tool: "Bash", input: { command } }, guard), guard.access)!
      .hookSpecificOutput.permissionDecisionReason;
  });
  const lines = calls.flatMap((command, i) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `guard-${i}`, name: "Bash", input: { command } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `guard-${i}`, is_error: true,
      content: i === 2 ? reasons[i] : `PreToolUse:Bash hook error: ${reasons[i]}` }] } },
  ]);
  const run = await runDriver("propose", { commandAccess: "most" }, [CLAUDE_FRESH_RUN[0]!, ...lines, {
    ...CLAUDE_FRESH_RUN[1], permission_denials: calls.map((command, i) => ({
      tool_name: "Bash", tool_use_id: `guard-${i}`, tool_input: { command },
    })),
  }]);
  const blocked = run.events.filter(e => e.type === "blocked").map(e => e.data!);
  assert.equal(blocked.length, 3);
  assert.deepEqual(blocked[0]!.refusal, { source: "crane.guard", reason: reasons[0]!.slice(GUARD_DENY_PREFIX.length).trim() });
  assert.deepEqual(blocked[0]!.guard, { category: "global-install", overridable: true });
  assert.deepEqual(blocked[0]!.rules, ["Bash(npm install:*)"], "defaults allow npm install but the guard requires an operator rule");
  assert.deepEqual(blocked[1]!.guard, { category: "operator-actions", overridable: false });
  assert.deepEqual(blocked[1]!.rules, []);
  assert.deepEqual(blocked[2]!.refusal, { source: "claude-code.tool_result", reason: reasons[2] });
  assert.deepEqual(blocked[2]!.rules, ["Bash(docker compose:*)"]);
});

test("guard: command access reaches Claude Code's appended system prompt", async () => {
  for (const commandAccess of ["listed", "most", "auto"] as const) {
    const run = await runDriver("propose", { commandAccess });
    const prompt = after(run.args, "--append-system-prompt");
    if (commandAccess === "most") assert.match(prompt, /Most commands are allowed in this worktree/);
    else assert.match(prompt, /guard also refuses operator actions and shared-branch changes/);
  }
  const observe = await runDriver("observe", { commandAccess: "most" });
  assert.doesNotMatch(after(observe.args, "--append-system-prompt"), /Most commands are allowed/);
});

test("guard: propose, act and conflict/fix-checks runs get the hook; investigate-only runs don't", async () => {
  const runs = {
    propose: await runDriver("propose"),
    act: await runDriver("act"),
    resolve: await runDriver("observe", { job: JOBS.resolve }),
    fix: await runDriver("act", { job: JOBS.fix }),
  };
  for (const [name, run] of Object.entries(runs)) {
    assert.ok(run.args.includes("--settings"), name);
    assert.ok(run.args.includes("--include-hook-events"), `${name}: the stream checks the guard answered`);
    const hook = hookOf(run.args);
    assert.equal(hook.matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit");
    assert.equal(hook.timeout, 10);
    assert.equal(hook.command, `'${process.execPath}' '${guardHookPath()}' ${hook.command.split(" ").at(-1)}`);
  }
  assert.equal(contextOf(runs.propose.args).profile, "worktree");
  assert.equal(contextOf(runs.act.args).profile, "worktree");
  assert.equal(contextOf(runs.resolve.args).profile, "job");
  assert.equal(contextOf(runs.fix.args).profile, "job");

  const observe = await runDriver("observe");
  assert.ok(!observe.args.includes("--settings"), "investigate-only runs get no guard in this task");
  assert.ok(!observe.args.includes("--include-hook-events"));
  assert.equal(after(observe.args, "--permission-mode"), "default");
});

test("guard: the hook's context comes from the run", async () => {
  const run = await runDriver("propose", { commandAccess: "most", craneHome: "/factory/home", allowedTools: ["Bash(docker compose:*)"] });
  assert.deepEqual(contextOf(run.args), {
    access: "most", profile: "worktree", worktree: run.cwd, checkout: "/code/app", defaultBranch: "trunk",
    craneHome: "/factory/home", home: homedir(), allowed: ["Bash(docker compose:*)"],
  });
  const plain = await runDriver("act");
  assert.equal(contextOf(plain.args).access, "listed", "unset command access means listed");
  assert.deepEqual(contextOf(plain.args).allowed, [], "Crane's default allowlist isn't passed as operator rules");
});

test("guard: every mode keeps ALWAYS_DENIED, the allowlist and the permission mode; none widens Bash", async () => {
  const baseline = await runDriver("propose", { allowedTools: ["Bash(docker compose:*)"] });
  for (const commandAccess of ["listed", "most", "auto"] as CommandAccess[]) {
    const { args } = await runDriver("propose", { commandAccess, allowedTools: ["Bash(docker compose:*)"] });
    assert.deepEqual(after(args, "--disallowedTools").split(","), ALWAYS_DENIED, commandAccess);
    assert.equal(after(args, "--allowedTools"), after(baseline.args, "--allowedTools"), `${commandAccess}: design A keeps the allowlist`);
    const allowed = after(args, "--allowedTools").split(",");
    assert.ok(!allowed.includes("Bash") && !allowed.includes("Bash(*)"), `${commandAccess}: no broad Bash`);
    assert.equal(after(args, "--permission-mode"), "acceptEdits");
    assert.ok(!args.includes("--dangerously-skip-permissions") && !args.includes("bypassPermissions"));
    assert.equal(contextOf(args).access, commandAccess);
  }
});

test("guard: the hook command runs through a shell and decides calls", async () => {
  const decide = async (commandAccess: CommandAccess, command: string) => {
    const { args, cwd } = await runDriver("propose", { commandAccess });
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_9", cwd });
    const out = spawnSync("/bin/sh", ["-c", hookOf(args).command], { input, encoding: "utf8", timeout: 20_000 });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput.permissionDecision : null;
  };
  assert.equal(await decide("listed", "npm run crane -- approve t-1"), "deny");
  assert.equal(await decide("auto", "git push origin HEAD"), "deny");
  assert.equal(await decide("auto", 'python3 -c "print(1)"'), null, "auto mode never allows");
  assert.equal(await decide("most", 'python3 -c "print(1)"'), "allow", "most mode frees commands outside the allowlist");
});

test("guard: a note records a command the guard didn't answer for", async () => {
  const bash = (id: string, command: string) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
  ];
  const answered = (id: string) => ({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", stderr: `crane-guard pass ${id}\n`, exit_code: 0 });
  const lines = [
    CLAUDE_FRESH_RUN[0]!,
    answered("tu1"), ...bash("tu1", "ls"),
    // Its stderr is only the agent's own output, so it doesn't count.
    { type: "system", subtype: "hook_response", hook_event: "PostToolUse", stderr: "crane-guard pass tu2\n" }, ...bash("tu2", "npm test"),
    ...bash("tu3", "npm test"),
    CLAUDE_FRESH_RUN[1]!,
  ];
  const notes = (run: Run) => run.events.filter((e) => e.type === "note" && e.message.startsWith("Crane's command guard didn't answer"));
  const guarded = notes(await runDriver("propose", {}, lines));
  assert.equal(guarded.length, 1, "one note per run");
  assert.equal(guarded[0]!.data!.toolUseId, "tu2");
  assert.equal(notes(await runDriver("propose", {}, [CLAUDE_FRESH_RUN[0]!, answered("tu1"), ...bash("tu1", "ls"), CLAUDE_FRESH_RUN[1]!])).length, 0);
  assert.equal(notes(await runDriver("observe", {}, lines)).length, 0, "investigate-only runs have no guard to miss");
});
